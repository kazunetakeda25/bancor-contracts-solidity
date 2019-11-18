pragma solidity 0.4.26;
import './interfaces/IBancorConverter.sol';
import './interfaces/IBancorConverterUpgrader.sol';
import './interfaces/IBancorFormula.sol';
import '../IBancorNetwork.sol';
import '../ContractIds.sol';
import '../FeatureIds.sol';
import '../utility/Managed.sol';
import '../utility/Utils.sol';
import '../utility/SafeMath.sol';
import '../utility/interfaces/IContractRegistry.sol';
import '../utility/interfaces/IContractFeatures.sol';
import '../utility/interfaces/IAddressList.sol';
import '../token/SmartTokenController.sol';
import '../token/interfaces/ISmartToken.sol';
import '../token/interfaces/INonStandardERC20.sol';
import '../token/interfaces/IEtherToken.sol';
import '../bancorx/interfaces/IBancorX.sol';

/**
  * @dev Bancor Converter
  * 
  * The Bancor converter allows for conversions between a Smart Token and other ERC20 tokens and between different ERC20 tokens and themselves. 
  * 
  * The ERC20 reserve balance can be virtual, meaning that conversions between reserve tokens are based on the virtual balance instead of relying on the actual reserve balance.
  * 
  * This mechanism opens the possibility to create different financial tools (for example, lower slippage in conversions).
  * 
  * The converter is upgradable (just like any SmartTokenController) and all upgrades are opt-in. 
  * 
  * WARNING: It is NOT RECOMMENDED to use the converter with Smart Tokens that have less than 8 decimal digits or with very small numbers because of precision loss 
  * 
  * Open issues:
  * - Front-running attacks are currently mitigated by the following mechanisms:
  *     - minimum return argument for each conversion provides a way to define a minimum/maximum price for the transaction
  *     - gas price limit prevents users from having control over the order of execution
  *     - gas price limit check can be skipped if the transaction comes from a trusted, whitelisted signer
  * 
  * Other potential solutions might include a commit/reveal based schemes
  * - Possibly add getters for the reserve fields so that the client won't need to rely on the order in the struct
*/
contract BancorConverter is IBancorConverter, SmartTokenController, Managed, ContractIds, FeatureIds {
    using SafeMath for uint256;

    uint32 private constant RATIO_RESOLUTION = 1000000;
    uint64 private constant CONVERSION_FEE_RESOLUTION = 1000000;

    struct Reserve {
        uint256 virtualBalance;         // reserve virtual balance
        uint32 ratio;                   // reserve ratio, represented in ppm, 1-1000000
        bool isVirtualBalanceEnabled;   // true if virtual balance is enabled, false if not
        bool isSaleEnabled;             // is sale of the reserve token enabled, can be set by the owner
        bool isSet;                     // used to tell if the mapping element is defined
    }

    /**
      * @dev version number
    */
    uint16 public version = 20;
    string public converterType = 'bancor';

    bool public allowRegistryUpdate = true;             // allows the owner to prevent/allow the registry to be updated
    IContractRegistry public prevRegistry;              // address of previous registry as security mechanism
    IContractRegistry public registry;                  // contract registry contract
    IWhitelist public conversionWhitelist;              // whitelist contract with list of addresses that are allowed to use the converter
    IERC20Token[] public reserveTokens;                 // ERC20 standard token addresses (prior version 17, use 'connectorTokens' instead)
    mapping (address => Reserve) public reserves;       // reserve token addresses -> reserve data (prior version 17, use 'connectors' instead)
    uint32 private totalReserveRatio = 0;               // used to efficiently prevent increasing the total reserve ratio above 100%
    uint32 public maxConversionFee = 0;                 // maximum conversion fee for the lifetime of the contract,
                                                        // represented in ppm, 0...1000000 (0 = no fee, 100 = 0.01%, 1000000 = 100%)
    uint32 public conversionFee = 0;                    // current conversion fee, represented in ppm, 0...maxConversionFee
    bool public conversionsEnabled = true;              // true if token conversions is enabled, false if not

    /**
      * @dev triggered when a conversion between two tokens occurs
      * 
      * @param _fromToken       ERC20 token converted from
      * @param _toToken         ERC20 token converted to
      * @param _trader          wallet that initiated the trade
      * @param _amount          amount converted, in fromToken
      * @param _return          amount returned, minus conversion fee
      * @param _conversionFee   conversion fee
    */
    event Conversion(
        address indexed _fromToken,
        address indexed _toToken,
        address indexed _trader,
        uint256 _amount,
        uint256 _return,
        int256 _conversionFee
    );

    /**
      * @dev triggered after a conversion with new price data
      * 
      * @param  _connectorToken     reserve token
      * @param  _tokenSupply        smart token supply
      * @param  _connectorBalance   reserve balance
      * @param  _connectorWeight    reserve ratio
    */
    event PriceDataUpdate(
        address indexed _connectorToken,
        uint256 _tokenSupply,
        uint256 _connectorBalance,
        uint32 _connectorWeight
    );

    /**
      * @dev triggered when the conversion fee is updated
      * 
      * @param  _prevFee    previous fee percentage, represented in ppm
      * @param  _newFee     new fee percentage, represented in ppm
    */
    event ConversionFeeUpdate(uint32 _prevFee, uint32 _newFee);

    /**
      * @dev triggered when conversions are enabled/disabled
      * 
      * @param  _conversionsEnabled true if conversions are enabled, false if not
    */
    event ConversionsEnable(bool _conversionsEnabled);

    /**
      * @dev triggered when virtual balances are enabled/disabled
      * 
      * @param  _enabled true if virtual balances are enabled, false if not
    */
    event VirtualBalancesEnable(bool _enabled);

    /**
      * @dev initializes a new BancorConverter instance
      * 
      * @param  _token              smart token governed by the converter
      * @param  _registry           address of a contract registry contract
      * @param  _maxConversionFee   maximum conversion fee, represented in ppm
      * @param  _reserveToken       optional, initial reserve, allows defining the first reserve at deployment time
      * @param  _reserveRatio       optional, ratio for the initial reserve
    */
    constructor(
        ISmartToken _token,
        IContractRegistry _registry,
        uint32 _maxConversionFee,
        IERC20Token _reserveToken,
        uint32 _reserveRatio
    )
        public
        SmartTokenController(_token)
        validAddress(_registry)
        validConversionFee(_maxConversionFee)
    {
        registry = _registry;
        prevRegistry = _registry;
        IContractFeatures features = IContractFeatures(registry.addressOf(ContractIds.CONTRACT_FEATURES));

        // initialize supported features
        if (features != address(0))
            features.enableFeatures(FeatureIds.CONVERTER_CONVERSION_WHITELIST, true);

        maxConversionFee = _maxConversionFee;

        if (_reserveToken != address(0))
            addReserve(_reserveToken, _reserveRatio);
    }

    // validates a reserve token address - verifies that the address belongs to one of the reserve tokens
    modifier validReserve(IERC20Token _address) {
        require(reserves[_address].isSet);
        _;
    }

    // validates conversion fee
    modifier validConversionFee(uint32 _conversionFee) {
        require(_conversionFee >= 0 && _conversionFee <= CONVERSION_FEE_RESOLUTION);
        _;
    }

    // validates reserve ratio
    modifier validReserveRatio(uint32 _ratio) {
        require(_ratio > 0 && _ratio <= RATIO_RESOLUTION);
        _;
    }

    // allows execution only when the total ratio is 100%
    modifier fullTotalRatioOnly() {
        require(totalReserveRatio == RATIO_RESOLUTION);
        _;
    }

    // allows execution only when conversions aren't disabled
    modifier conversionsAllowed {
        require(conversionsEnabled);
        _;
    }

    // allows execution by the BancorNetwork contract only
    modifier bancorNetworkOnly {
        IBancorNetwork bancorNetwork = IBancorNetwork(registry.addressOf(ContractIds.BANCOR_NETWORK));
        require(msg.sender == address(bancorNetwork));
        _;
    }

    // allows execution by the converter upgrader contract only
    modifier converterUpgraderOnly {
        address converterUpgrader = registry.addressOf(ContractIds.BANCOR_CONVERTER_UPGRADER);
        require(msg.sender == converterUpgrader);
        _;
    }

    // allows execution only if the total-supply of the token is greater than zero
    modifier totalSupplyGreaterThanZeroOnly {
        require(token.totalSupply() > 0);
        _;
    }

    /**
      * @dev sets the contract registry to whichever address the current registry is pointing to
     */
    function updateRegistry() public {
        // require that upgrading is allowed or that the caller is the owner
        require(allowRegistryUpdate || msg.sender == owner);

        // get the address of whichever registry the current registry is pointing to
        address newRegistry = registry.addressOf(ContractIds.CONTRACT_REGISTRY);

        // if the new registry hasn't changed or is the zero address, revert
        require(newRegistry != address(registry) && newRegistry != address(0));

        // set the previous registry as current registry and current registry as newRegistry
        prevRegistry = registry;
        registry = IContractRegistry(newRegistry);
    }

    /**
      * @dev security mechanism allowing the converter owner to revert to the previous registry,
      * to be used in emergency scenario
    */
    function restoreRegistry() public ownerOrManagerOnly {
        // set the registry as previous registry
        registry = prevRegistry;

        // after a previous registry is restored, only the owner can allow future updates
        allowRegistryUpdate = false;
    }

    /**
      * @dev disables the registry update functionality
      * this is a safety mechanism in case of a emergency
      * can only be called by the manager or owner
      * 
      * @param _disable    true to disable registry updates, false to re-enable them
    */
    function disableRegistryUpdate(bool _disable) public ownerOrManagerOnly {
        allowRegistryUpdate = !_disable;
    }

    /**
      * @dev returns the number of reserve tokens defined
      * note that prior to version 17, you should use 'connectorTokenCount' instead
      * 
      * @return number of reserve tokens
    */
    function reserveTokenCount() public view returns (uint16) {
        return uint16(reserveTokens.length);
    }

    /**
      * @dev allows the owner to update & enable the conversion whitelist contract address
      * when set, only addresses that are whitelisted are actually allowed to use the converter
      * note that the whitelist check is actually done by the BancorNetwork contract
      * 
      * @param _whitelist    address of a whitelist contract
    */
    function setConversionWhitelist(IWhitelist _whitelist)
        public
        ownerOnly
        notThis(_whitelist)
    {
        conversionWhitelist = _whitelist;
    }

    /**
      * @dev disables the entire conversion functionality
      * this is a safety mechanism in case of a emergency
      * can only be called by the manager
      * 
      * @param _disable true to disable conversions, false to re-enable them
    */
    function disableConversions(bool _disable) public ownerOrManagerOnly {
        if (conversionsEnabled == _disable) {
            conversionsEnabled = !_disable;
            emit ConversionsEnable(conversionsEnabled);
        }
    }

    /**
      * @dev allows transferring the token ownership
      * the new owner needs to accept the transfer
      * can only be called by the contract owner
      * note that token ownership can only be transferred while the owner is the converter upgrader contract
      * 
      * @param _newOwner    new token owner
    */
    function transferTokenOwnership(address _newOwner)
        public
        ownerOnly
        converterUpgraderOnly
    {
        super.transferTokenOwnership(_newOwner);
    }

    /**
      * @dev used by a new owner to accept a token ownership transfer
      * can only be called by the contract owner
      * note that token ownership can only be accepted if its total-supply is greater than zero
    */
    function acceptTokenOwnership()
        public
        ownerOnly
        totalSupplyGreaterThanZeroOnly
    {
        super.acceptTokenOwnership();
    }

    /**
      * @dev updates the current conversion fee
      * can only be called by the manager
      * 
      * @param _conversionFee new conversion fee, represented in ppm
    */
    function setConversionFee(uint32 _conversionFee)
        public
        ownerOrManagerOnly
    {
        require(_conversionFee >= 0 && _conversionFee <= maxConversionFee);
        emit ConversionFeeUpdate(conversionFee, _conversionFee);
        conversionFee = _conversionFee;
    }

    /**
      * @dev given a return amount, returns the amount minus the conversion fee
      * 
      * @param _amount      return amount
      * @param _magnitude   1 for standard conversion, 2 for cross reserve conversion
      * 
      * @return return amount minus conversion fee
    */
    function getFinalAmount(uint256 _amount, uint8 _magnitude) public view returns (uint256) {
        return _amount.mul((CONVERSION_FEE_RESOLUTION - conversionFee) ** _magnitude).div(CONVERSION_FEE_RESOLUTION ** _magnitude);
    }

    /**
      * @dev withdraws tokens held by the converter and sends them to an account
      * can only be called by the owner
      * note that reserve tokens can only be withdrawn by the owner while the converter is inactive
      * unless the owner is the converter upgrader contract
      * 
      * @param _token   ERC20 token contract address
      * @param _to      account to receive the new amount
      * @param _amount  amount to withdraw
    */
    function withdrawTokens(IERC20Token _token, address _to, uint256 _amount) public {
        address converterUpgrader = registry.addressOf(ContractIds.BANCOR_CONVERTER_UPGRADER);

        // if the token is not a reserve token, allow withdrawal
        // otherwise verify that the converter is inactive or that the owner is the upgrader contract
        require(!reserves[_token].isSet || token.owner() != address(this) || owner == converterUpgrader);
        super.withdrawTokens(_token, _to, _amount);
    }

    /**
      * @dev upgrades the converter to the latest version
      * can only be called by the owner
      * note that the owner needs to call acceptOwnership/acceptManagement on the new converter after the upgrade
    */
    function upgrade() public ownerOnly {
        IBancorConverterUpgrader converterUpgrader = IBancorConverterUpgrader(registry.addressOf(ContractIds.BANCOR_CONVERTER_UPGRADER));

        transferOwnership(converterUpgrader);
        converterUpgrader.upgrade(version);
        acceptOwnership();
    }

    /**
      * @dev defines a new reserve for the token
      * can only be called by the owner while the converter is inactive
      * note that prior to version 17, you should use 'addConnector' instead
      * 
      * @param _token                  address of the reserve token
      * @param _ratio                  constant reserve ratio, represented in ppm, 1-1000000
    */
    function addReserve(IERC20Token _token, uint32 _ratio)
        public
        ownerOnly
        inactive
        validAddress(_token)
        notThis(_token)
        validReserveRatio(_ratio)
    {
        require(_token != token && !reserves[_token].isSet && totalReserveRatio + _ratio <= RATIO_RESOLUTION); // validate input

        reserves[_token].ratio = _ratio;
        reserves[_token].isVirtualBalanceEnabled = false;
        reserves[_token].virtualBalance = 0;
        reserves[_token].isSaleEnabled = true;
        reserves[_token].isSet = true;
        reserveTokens.push(_token);
        totalReserveRatio += _ratio;
    }

    /**
      * @dev updates a reserve's virtual balance
      * only used during an upgrade process
      * can only be called by the contract owner while the owner is the converter upgrader contract
      * note that prior to version 17, you should use 'updateConnector' instead
      * 
      * @param _reserveToken    address of the reserve token
      * @param _virtualBalance  new reserve virtual balance, or 0 to disable virtual balance
    */
    function updateReserveVirtualBalance(IERC20Token _reserveToken, uint256 _virtualBalance)
        public
        ownerOnly
        converterUpgraderOnly
        validReserve(_reserveToken)
    {
        Reserve storage reserve = reserves[_reserveToken];
        reserve.isVirtualBalanceEnabled = _virtualBalance != 0;
        reserve.virtualBalance = _virtualBalance;
    }

    /**
      * @dev enables virtual balance for the reserves
      * virtual balance only affects conversions between reserve tokens
      * virtual balance of all reserves can only scale by the same factor, to keep the ratio between them the same
      * note that the balance is determined during the execution of this function and set statically -
      * meaning that it's not calculated dynamically based on the factor after each conversion
      * can only be called by the contract owner while the converter is active
      * 
      * @param _scaleFactor  percentage, 100-1000 (100 = no virtual balance, 1000 = virtual balance = actual balance * 10)
    */
    function enableVirtualBalances(uint16 _scaleFactor)
        public
        ownerOnly
        active
    {
        // validate input
        require(_scaleFactor >= 100 && _scaleFactor <= 1000);
        bool enable = _scaleFactor != 100;

        // iterate through the reserves and scale their balance by the ratio provided,
        // or disable virtual balance altogether if a factor of 100% is passed in
        IERC20Token reserveToken;
        for (uint16 i = 0; i < reserveTokens.length; i++) {
            reserveToken = reserveTokens[i];
            Reserve storage reserve = reserves[reserveToken];
            reserve.isVirtualBalanceEnabled = enable;
            reserve.virtualBalance = enable ? reserveToken.balanceOf(this).mul(_scaleFactor).div(100) : 0;
        }

        emit VirtualBalancesEnable(enable);
    }

    /**
      * @dev disables converting from the given reserve token in case the reserve token got compromised
      * can only be called by the owner
      * note that converting to the token is still enabled regardless of this flag and it cannot be disabled by the owner
      * note that prior to version 17, you should use 'disableConnectorSale' instead
      * 
      * @param _reserveToken    reserve token contract address
      * @param _disable         true to disable the token, false to re-enable it
    */
    function disableReserveSale(IERC20Token _reserveToken, bool _disable)
        public
        ownerOnly
        validReserve(_reserveToken)
    {
        reserves[_reserveToken].isSaleEnabled = !_disable;
    }

    /**
      * @dev returns the reserve's virtual balance if one is defined, otherwise returns the actual balance
      * note that prior to version 17, you should use 'getConnectorBalance' instead
      * 
      * @param _reserveToken    reserve token contract address
      * 
      * @return reserve balance
    */
    function getReserveBalance(IERC20Token _reserveToken)
        public
        view
        validReserve(_reserveToken)
        returns (uint256)
    {
        Reserve storage reserve = reserves[_reserveToken];
        return reserve.isVirtualBalanceEnabled ? reserve.virtualBalance : _reserveToken.balanceOf(this);
    }

    /**
      * @dev calculates the expected return of converting a given amount of tokens
      * 
      * @param _fromToken  contract address of the token to convert from
      * @param _toToken    contract address of the token to convert to
      * @param _amount     amount of tokens received from the user
      * 
      * @return amount of tokens that the user will receive
      * @return amount of tokens that the user will pay as fee
    */
    function getReturn(IERC20Token _fromToken, IERC20Token _toToken, uint256 _amount) public view returns (uint256, uint256) {
        require(_fromToken != _toToken); // validate input

        // conversion between the token and one of its reserves
        if (_toToken == token)
            return getPurchaseReturn(_fromToken, _amount);
        else if (_fromToken == token)
            return getSaleReturn(_toToken, _amount);

        // conversion between 2 reserves
        return getCrossReserveReturn(_fromToken, _toToken, _amount);
    }

    /**
      * @dev calculates the expected return of buying with a given amount of tokens
      * 
      * @param _reserveToken    contract address of the reserve token
      * @param _depositAmount   amount of reserve-tokens received from the user
      * 
      * @return amount of supply-tokens that the user will receive
      * @return amount of supply-tokens that the user will pay as fee
    */
    function getPurchaseReturn(IERC20Token _reserveToken, uint256 _depositAmount)
        public
        view
        active
        validReserve(_reserveToken)
        returns (uint256, uint256)
    {
        Reserve storage reserve = reserves[_reserveToken];
        require(reserve.isSaleEnabled); // validate input

        uint256 tokenSupply = token.totalSupply();
        uint256 reserveBalance = _reserveToken.balanceOf(this);
        IBancorFormula formula = IBancorFormula(registry.addressOf(ContractIds.BANCOR_FORMULA));
        uint256 amount = formula.calculatePurchaseReturn(tokenSupply, reserveBalance, reserve.ratio, _depositAmount);
        uint256 finalAmount = getFinalAmount(amount, 1);

        // return the amount minus the conversion fee and the conversion fee
        return (finalAmount, amount - finalAmount);
    }

    /**
      * @dev calculates the expected return of selling a given amount of tokens
      * 
      * @param _reserveToken    contract address of the reserve token
      * @param _sellAmount      amount of supply-tokens received from the user
      * 
      * @return amount of reserve-tokens that the user will receive
      * @return amount of reserve-tokens that the user will pay as fee
    */
    function getSaleReturn(IERC20Token _reserveToken, uint256 _sellAmount)
        public
        view
        active
        validReserve(_reserveToken)
        returns (uint256, uint256)
    {
        Reserve storage reserve = reserves[_reserveToken];
        uint256 tokenSupply = token.totalSupply();
        uint256 reserveBalance = _reserveToken.balanceOf(this);
        IBancorFormula formula = IBancorFormula(registry.addressOf(ContractIds.BANCOR_FORMULA));
        uint256 amount = formula.calculateSaleReturn(tokenSupply, reserveBalance, reserve.ratio, _sellAmount);
        uint256 finalAmount = getFinalAmount(amount, 1);

        // return the amount minus the conversion fee and the conversion fee
        return (finalAmount, amount - finalAmount);
    }

    /**
      * @dev calculates the expected return of converting a given amount from one reserve to another
      * note that prior to version 17, you should use 'getCrossConnectorReturn' instead
      * 
      * @param _fromReserveToken    contract address of the reserve token to convert from
      * @param _toReserveToken      contract address of the reserve token to convert to
      * @param _amount              amount of tokens received from the user
      * 
      * @return amount of tokens that the user will receive
      * @return amount of tokens that the user will pay as fee
    */
    function getCrossReserveReturn(IERC20Token _fromReserveToken, IERC20Token _toReserveToken, uint256 _amount)
        public
        view
        active
        validReserve(_fromReserveToken)
        validReserve(_toReserveToken)
        returns (uint256, uint256)
    {
        Reserve storage fromReserve = reserves[_fromReserveToken];
        Reserve storage toReserve = reserves[_toReserveToken];
        require(fromReserve.isSaleEnabled); // validate input

        IBancorFormula formula = IBancorFormula(registry.addressOf(ContractIds.BANCOR_FORMULA));
        uint256 amount = formula.calculateCrossReserveReturn(
            getReserveBalance(_fromReserveToken), 
            fromReserve.ratio, 
            getReserveBalance(_toReserveToken), 
            toReserve.ratio, 
            _amount);
        uint256 finalAmount = getFinalAmount(amount, 2);

        // return the amount minus the conversion fee and the conversion fee
        // the fee is higher (magnitude = 2) since cross reserve conversion equals 2 conversions (from / to the smart token)
        return (finalAmount, amount - finalAmount);
    }

    /**
      * @dev converts a specific amount of _fromToken to _toToken
      * can only be called by the bancor network contract
      * 
      * @param _fromToken  ERC20 token to convert from
      * @param _toToken    ERC20 token to convert to
      * @param _amount     amount to convert, in fromToken
      * @param _minReturn  if the conversion results in an amount smaller than the minimum return - it is cancelled, must be nonzero
      * 
      * @return conversion return amount
    */
    function convertInternal(IERC20Token _fromToken, IERC20Token _toToken, uint256 _amount, uint256 _minReturn)
        public
        bancorNetworkOnly
        conversionsAllowed
        greaterThanZero(_minReturn)
        returns (uint256)
    {
        require(_fromToken != _toToken); // validate input

        // conversion between the token and one of its reserves
        if (_toToken == token)
            return buy(_fromToken, _amount, _minReturn);
        else if (_fromToken == token)
            return sell(_toToken, _amount, _minReturn);

        uint256 amount;
        uint256 feeAmount;

        // conversion between 2 reserves
        (amount, feeAmount) = getCrossReserveReturn(_fromToken, _toToken, _amount);
        // ensure the trade gives something in return and meets the minimum requested amount
        require(amount != 0 && amount >= _minReturn);

        // update the source token virtual balance if relevant
        Reserve storage fromReserve = reserves[_fromToken];
        if (fromReserve.isVirtualBalanceEnabled)
            fromReserve.virtualBalance = fromReserve.virtualBalance.add(_amount);

        // update the target token virtual balance if relevant
        Reserve storage toReserve = reserves[_toToken];
        if (toReserve.isVirtualBalanceEnabled)
            toReserve.virtualBalance = toReserve.virtualBalance.sub(amount);

        // ensure that the trade won't deplete the reserve balance
        uint256 toReserveBalance = getReserveBalance(_toToken);
        assert(amount < toReserveBalance);

        // transfer funds from the caller in the from reserve token
        ensureTransferFrom(_fromToken, msg.sender, this, _amount);
        // transfer funds to the caller in the to reserve token
        // the transfer might fail if virtual balance is enabled
        ensureTransfer(_toToken, msg.sender, amount);

        // dispatch the conversion event
        // the fee is higher (magnitude = 2) since cross reserve conversion equals 2 conversions (from / to the smart token)
        dispatchConversionEvent(_fromToken, _toToken, _amount, amount, feeAmount);

        // dispatch price data updates for the smart token / both reserves
        emit PriceDataUpdate(_fromToken, token.totalSupply(), _fromToken.balanceOf(this), fromReserve.ratio);
        emit PriceDataUpdate(_toToken, token.totalSupply(), _toToken.balanceOf(this), toReserve.ratio);
        return amount;
    }

    /**
      * @dev buys the token by depositing one of its reserve tokens
      * 
      * @param _reserveToken    reserve token contract address
      * @param _depositAmount   amount to deposit (in the reserve token)
      * @param _minReturn       if the conversion results in an amount smaller than the minimum return - it is cancelled, must be nonzero
      * 
      * @return buy return amount
    */
    function buy(IERC20Token _reserveToken, uint256 _depositAmount, uint256 _minReturn) internal returns (uint256) {
        uint256 amount;
        uint256 feeAmount;
        (amount, feeAmount) = getPurchaseReturn(_reserveToken, _depositAmount);
        // ensure the trade gives something in return and meets the minimum requested amount
        require(amount != 0 && amount >= _minReturn);

        // update virtual balance if relevant
        Reserve storage reserve = reserves[_reserveToken];
        if (reserve.isVirtualBalanceEnabled)
            reserve.virtualBalance = reserve.virtualBalance.add(_depositAmount);

        // transfer funds from the caller in the reserve token
        ensureTransferFrom(_reserveToken, msg.sender, this, _depositAmount);
        // issue new funds to the caller in the smart token
        token.issue(msg.sender, amount);

        // dispatch the conversion event
        dispatchConversionEvent(_reserveToken, token, _depositAmount, amount, feeAmount);

        // dispatch price data update for the smart token/reserve
        emit PriceDataUpdate(_reserveToken, token.totalSupply(), _reserveToken.balanceOf(this), reserve.ratio);
        return amount;
    }

    /**
      * @dev sells the token by withdrawing from one of its reserve tokens
      * 
      * @param _reserveToken    reserve token contract address
      * @param _sellAmount      amount to sell (in the smart token)
      * @param _minReturn       if the conversion results in an amount smaller the minimum return - it is cancelled, must be nonzero
      * 
      * @return sell return amount
    */
    function sell(IERC20Token _reserveToken, uint256 _sellAmount, uint256 _minReturn) internal returns (uint256) {
        require(_sellAmount <= token.balanceOf(msg.sender)); // validate input
        uint256 amount;
        uint256 feeAmount;
        (amount, feeAmount) = getSaleReturn(_reserveToken, _sellAmount);
        // ensure the trade gives something in return and meets the minimum requested amount
        require(amount != 0 && amount >= _minReturn);

        // ensure that the trade will only deplete the reserve balance if the total supply is depleted as well
        uint256 tokenSupply = token.totalSupply();
        uint256 reserveBalance = _reserveToken.balanceOf(this);
        assert(amount < reserveBalance || (amount == reserveBalance && _sellAmount == tokenSupply));

        // update virtual balance if relevant
        Reserve storage reserve = reserves[_reserveToken];
        if (reserve.isVirtualBalanceEnabled)
            reserve.virtualBalance = reserve.virtualBalance.sub(amount);

        // destroy _sellAmount from the caller's balance in the smart token
        token.destroy(msg.sender, _sellAmount);
        // transfer funds to the caller in the reserve token
        ensureTransfer(_reserveToken, msg.sender, amount);

        // dispatch the conversion event
        dispatchConversionEvent(token, _reserveToken, _sellAmount, amount, feeAmount);

        // dispatch price data update for the smart token/reserve
        emit PriceDataUpdate(_reserveToken, token.totalSupply(), _reserveToken.balanceOf(this), reserve.ratio);
        return amount;
    }

    /**
      * @dev converts a specific amount of _fromToken to _toToken
      * note that prior to version 16, you should use 'convert' instead
      * 
      * @param _fromToken           ERC20 token to convert from
      * @param _toToken             ERC20 token to convert to
      * @param _amount              amount to convert, in fromToken
      * @param _minReturn           if the conversion results in an amount smaller than the minimum return - it is cancelled, must be nonzero
      * @param _affiliateAccount    affiliate account
      * @param _affiliateFee        affiliate fee in PPM
      * 
      * @return conversion return amount
    */
    function convert2(IERC20Token _fromToken, IERC20Token _toToken, uint256 _amount, uint256 _minReturn, address _affiliateAccount, uint256 _affiliateFee) public returns (uint256) {
        IERC20Token[] memory path = new IERC20Token[](3);
        (path[0], path[1], path[2]) = (_fromToken, token, _toToken);
        return quickConvert2(path, _amount, _minReturn, _affiliateAccount, _affiliateFee);
    }

    /**
      * @dev converts the token to any other token in the bancor network by following a predefined conversion path
      * note that when converting from an ERC20 token (as opposed to a smart token), allowance must be set beforehand
      * note that prior to version 16, you should use 'quickConvert' instead
      * 
      * @param _path                conversion path, see conversion path format in the BancorNetwork contract
      * @param _amount              amount to convert from (in the initial source token)
      * @param _minReturn           if the conversion results in an amount smaller than the minimum return - it is cancelled, must be nonzero
      * @param _affiliateAccount    affiliate account
      * @param _affiliateFee        affiliate fee in PPM
      * 
      * @return tokens issued in return
    */
    function quickConvert2(IERC20Token[] _path, uint256 _amount, uint256 _minReturn, address _affiliateAccount, uint256 _affiliateFee)
        public
        payable
        returns (uint256)
    {
        return quickConvertPrioritized2(_path, _amount, _minReturn, getSignature(0x0, 0x0, 0x0, 0x0, 0x0), _affiliateAccount, _affiliateFee);
    }

    /**
      * @dev converts the token to any other token in the bancor network by following a predefined conversion path
      * note that when converting from an ERC20 token (as opposed to a smart token), allowance must be set beforehand
      * note that prior to version 16, you should use 'quickConvertPrioritized' instead
      * 
      * @param _path                conversion path, see conversion path format in the BancorNetwork contract
      * @param _amount              amount to convert from (in the initial source token)
      * @param _minReturn           if the conversion results in an amount smaller than the minimum return - it is cancelled, must be nonzero
      * @param _signature           an array of the following elements:
      *     [0] uint256             custom value that was signed for prioritized conversion; must be equal to _amount
      *     [1] uint256             if the current block exceeded the given parameter - it is cancelled
      *     [2] uint8               (signature[128:130]) associated with the signer address and helps to validate if the signature is legit
      *     [3] bytes32             (signature[0:64]) associated with the signer address and helps to validate if the signature is legit
      *     [4] bytes32             (signature[64:128]) associated with the signer address and helps to validate if the signature is legit
      * if the array is empty (length == 0), then the gas-price limit is verified instead of the signature
      * @param _affiliateAccount    affiliate account
      * @param _affiliateFee        affiliate fee in PPM
      * 
      * @return tokens issued in return
    */
    function quickConvertPrioritized2(IERC20Token[] _path, uint256 _amount, uint256 _minReturn, uint256[] memory _signature, address _affiliateAccount, uint256 _affiliateFee)
        public
        payable
        returns (uint256)
    {
        require(_signature.length == 0 || _signature[0] == _amount);

        IBancorNetwork bancorNetwork = IBancorNetwork(registry.addressOf(ContractIds.BANCOR_NETWORK));

        // we need to transfer the source tokens from the caller to the BancorNetwork contract,
        // so it can execute the conversion on behalf of the caller
        if (msg.value == 0) {
            // not ETH, send the source tokens to the BancorNetwork contract
            // if the token is the smart token, no allowance is required - destroy the tokens
            // from the caller and issue them to the BancorNetwork contract
            if (_path[0] == token) {
                token.destroy(msg.sender, _amount); // destroy _amount tokens from the caller's balance in the smart token
                token.issue(bancorNetwork, _amount); // issue _amount new tokens to the BancorNetwork contract
            } else {
                // otherwise, we assume we already have allowance, transfer the tokens directly to the BancorNetwork contract
                ensureTransferFrom(_path[0], msg.sender, bancorNetwork, _amount);
            }
        }

        // execute the conversion and pass on the ETH with the call
        return bancorNetwork.convertForPrioritized4.value(msg.value)(_path, _amount, _minReturn, msg.sender, _signature, _affiliateAccount, _affiliateFee);
    }

    /**
      * @dev allows a user to convert BNT that was sent from another blockchain into any other
      * token on the BancorNetwork without specifying the amount of BNT to be converted, but
      * rather by providing the xTransferId which allows us to get the amount from BancorX.
      * note that prior to version 16, you should use 'completeXConversion' instead
      * 
      * @param _path            conversion path, see conversion path format in the BancorNetwork contract
      * @param _minReturn       if the conversion results in an amount smaller than the minimum return - it is cancelled, must be nonzero
      * @param _conversionId    pre-determined unique (if non zero) id which refers to this transaction 
      * @param _signature       an array of the following elements:
      *     [0] uint256         custom value that was signed for prioritized conversion; must be equal to _conversionId
      *     [1] uint256         if the current block exceeded the given parameter - it is cancelled
      *     [2] uint8           (signature[128:130]) associated with the signer address and helps to validate if the signature is legit
      *     [3] bytes32         (signature[0:64]) associated with the signer address and helps to validate if the signature is legit
      *     [4] bytes32         (signature[64:128]) associated with the signer address and helps to validate if the signature is legit
      * if the array is empty (length == 0), then the gas-price limit is verified instead of the signature
      * 
      * @return tokens issued in return
    */
    function completeXConversion2(
        IERC20Token[] _path,
        uint256 _minReturn,
        uint256 _conversionId,
        uint256[] memory _signature
    )
        public
        returns (uint256)
    {
        // verify that the custom value (if valid) is equal to _conversionId
        require(_signature.length == 0 || _signature[0] == _conversionId);

        IBancorX bancorX = IBancorX(registry.addressOf(ContractIds.BANCOR_X));
        IBancorNetwork bancorNetwork = IBancorNetwork(registry.addressOf(ContractIds.BANCOR_NETWORK));

        // verify that the first token in the path is BNT
        require(_path[0] == registry.addressOf(ContractIds.BNT_TOKEN));

        // get conversion amount from BancorX contract
        uint256 amount = bancorX.getXTransferAmount(_conversionId, msg.sender);

        // send BNT from msg.sender to the BancorNetwork contract
        token.destroy(msg.sender, amount);
        token.issue(bancorNetwork, amount);

        return bancorNetwork.convertForPrioritized4(_path, amount, _minReturn, msg.sender, _signature, address(0), 0);
    }

    /**
      * @dev ensures transfer of tokens, taking into account that some ERC-20 implementations don't return
      * true on success but revert on failure instead
      * 
      * @param _token     the token to transfer
      * @param _to        the address to transfer the tokens to
      * @param _amount    the amount to transfer
    */
    function ensureTransfer(IERC20Token _token, address _to, uint256 _amount) private {
        IAddressList addressList = IAddressList(registry.addressOf(ContractIds.NON_STANDARD_TOKEN_REGISTRY));

        if (addressList.listedAddresses(_token)) {
            uint256 prevBalance = _token.balanceOf(_to);
            // we have to cast the token contract in an interface which has no return value
            INonStandardERC20(_token).transfer(_to, _amount);
            uint256 postBalance = _token.balanceOf(_to);
            assert(postBalance > prevBalance);
        } else {
            // if the token isn't whitelisted, we assert on transfer
            assert(_token.transfer(_to, _amount));
        }
    }

    /**
      * @dev ensures transfer of tokens, taking into account that some ERC-20 implementations don't return
      * true on success but revert on failure instead
      * 
      * @param _token     the token to transfer
      * @param _from      the address to transfer the tokens from
      * @param _to        the address to transfer the tokens to
      * @param _amount    the amount to transfer
    */
    function ensureTransferFrom(IERC20Token _token, address _from, address _to, uint256 _amount) private {
        IAddressList addressList = IAddressList(registry.addressOf(ContractIds.NON_STANDARD_TOKEN_REGISTRY));

        if (addressList.listedAddresses(_token)) {
            uint256 prevBalance = _token.balanceOf(_to);
            // we have to cast the token contract in an interface which has no return value
            INonStandardERC20(_token).transferFrom(_from, _to, _amount);
            uint256 postBalance = _token.balanceOf(_to);
            assert(postBalance > prevBalance);
        } else {
            // if the token is standard, we assert on transfer
            assert(_token.transferFrom(_from, _to, _amount));
        }
    }

    /**
      * @dev buys the token with all reserve tokens using the same percentage
      * for example, if the caller increases the supply by 10%,
      * then it will cost an amount equal to 10% of each reserve token balance
      * note that the function can be called only if the total ratio is 100% and conversions are enabled
      * 
      * @param _amount  amount to increase the supply by (in the smart token)
    */
    function fund(uint256 _amount)
        public
        fullTotalRatioOnly
        conversionsAllowed
    {
        uint256 supply = token.totalSupply();

        // iterate through the reserve tokens and transfer a percentage equal to the ratio between _amount
        // and the total supply in each reserve from the caller to the converter
        IERC20Token reserveToken;
        uint256 reserveBalance;
        uint256 reserveAmount;
        for (uint16 i = 0; i < reserveTokens.length; i++) {
            reserveToken = reserveTokens[i];
            reserveBalance = reserveToken.balanceOf(this);
            reserveAmount = _amount.mul(reserveBalance).sub(1).div(supply).add(1);

            // update virtual balance if relevant
            Reserve storage reserve = reserves[reserveToken];
            if (reserve.isVirtualBalanceEnabled)
                reserve.virtualBalance = reserve.virtualBalance.add(reserveAmount);

            // transfer funds from the caller in the reserve token
            ensureTransferFrom(reserveToken, msg.sender, this, reserveAmount);

            // dispatch price data update for the smart token/reserve
            emit PriceDataUpdate(reserveToken, supply + _amount, reserveBalance + reserveAmount, reserve.ratio);
        }

        // issue new funds to the caller in the smart token
        token.issue(msg.sender, _amount);
    }

    /**
      * @dev sells the token for all reserve tokens using the same percentage
      * for example, if the holder sells 10% of the supply,
      * then they will receive 10% of each reserve token balance in return
      * note that the function can be called only if the total ratio is 100%
      * 
      * @param _amount  amount to liquidate (in the smart token)
    */
    function liquidate(uint256 _amount) public fullTotalRatioOnly {
        uint256 supply = token.totalSupply();

        // destroy _amount from the caller's balance in the smart token
        token.destroy(msg.sender, _amount);

        // iterate through the reserve tokens and send a percentage equal to the ratio between _amount
        // and the total supply from each reserve balance to the caller
        IERC20Token reserveToken;
        uint256 reserveBalance;
        uint256 reserveAmount;
        for (uint16 i = 0; i < reserveTokens.length; i++) {
            reserveToken = reserveTokens[i];
            reserveBalance = reserveToken.balanceOf(this);
            reserveAmount = _amount.mul(reserveBalance).div(supply);

            // update virtual balance if relevant
            Reserve storage reserve = reserves[reserveToken];
            if (reserve.isVirtualBalanceEnabled)
                reserve.virtualBalance = reserve.virtualBalance.sub(reserveAmount);

            // transfer funds to the caller in the reserve token
            ensureTransfer(reserveToken, msg.sender, reserveAmount);

            // dispatch price data update for the smart token/reserve
            emit PriceDataUpdate(reserveToken, supply - _amount, reserveBalance - reserveAmount, reserve.ratio);
        }
    }

    /**
      * @dev helper, dispatches the Conversion event
      * 
      * @param _fromToken       ERC20 token to convert from
      * @param _toToken         ERC20 token to convert to
      * @param _amount          amount purchased/sold (in the source token)
      * @param _returnAmount    amount returned (in the target token)
    */
    function dispatchConversionEvent(IERC20Token _fromToken, IERC20Token _toToken, uint256 _amount, uint256 _returnAmount, uint256 _feeAmount) private {
        // fee amount is converted to 255 bits -
        // negative amount means the fee is taken from the source token, positive amount means its taken from the target token
        // currently the fee is always taken from the target token
        // since we convert it to a signed number, we first ensure that it's capped at 255 bits to prevent overflow
        assert(_feeAmount < 2 ** 255);
        emit Conversion(_fromToken, _toToken, msg.sender, _amount, _returnAmount, int256(_feeAmount));
    }

    function getSignature(
        uint256 _customVal,
        uint256 _block,
        uint8 _v,
        bytes32 _r,
        bytes32 _s
    ) private pure returns (uint256[] memory) {
        if (_v == 0x0 && _r == 0x0 && _s == 0x0)
            return new uint256[](0);
        uint256[] memory signature = new uint256[](5);
        signature[0] = _customVal;
        signature[1] = _block;
        signature[2] = uint256(_v);
        signature[3] = uint256(_r);
        signature[4] = uint256(_s);
        return signature;
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function change(IERC20Token _fromToken, IERC20Token _toToken, uint256 _amount, uint256 _minReturn) public returns (uint256) {
        return convertInternal(_fromToken, _toToken, _amount, _minReturn);
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function convert(IERC20Token _fromToken, IERC20Token _toToken, uint256 _amount, uint256 _minReturn) public returns (uint256) {
        return convert2(_fromToken, _toToken, _amount, _minReturn, address(0), 0);
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function quickConvert(IERC20Token[] _path, uint256 _amount, uint256 _minReturn) public payable returns (uint256) {
        return quickConvert2(_path, _amount, _minReturn, address(0), 0);
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function quickConvertPrioritized(IERC20Token[] _path, uint256 _amount, uint256 _minReturn, uint256 _block, uint8 _v, bytes32 _r, bytes32 _s) public payable returns (uint256) {
        return quickConvertPrioritized2(_path, _amount, _minReturn, getSignature(_amount, _block, _v, _r, _s), address(0), 0);
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function completeXConversion(IERC20Token[] _path, uint256 _minReturn, uint256 _conversionId, uint256 _block, uint8 _v, bytes32 _r, bytes32 _s) public returns (uint256) {
        return completeXConversion2(_path, _minReturn, _conversionId, getSignature(_conversionId, _block, _v, _r, _s));
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function connectors(address _address) public view returns (uint256, uint32, bool, bool, bool) {
        Reserve storage reserve = reserves[_address];
        return(reserve.virtualBalance, reserve.ratio, reserve.isVirtualBalanceEnabled, reserve.isSaleEnabled, reserve.isSet);
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function connectorTokens(uint256 _index) public view returns (IERC20Token) {
        return BancorConverter.reserveTokens[_index];
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function connectorTokenCount() public view returns (uint16) {
        return reserveTokenCount();
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function addConnector(IERC20Token _token, uint32 _weight, bool /*_enableVirtualBalance*/) public {
        addReserve(_token, _weight);
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function updateConnector(IERC20Token _connectorToken, uint32 /*_weight*/, bool /*_enableVirtualBalance*/, uint256 _virtualBalance) public {
        updateReserveVirtualBalance(_connectorToken, _virtualBalance);
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function disableConnectorSale(IERC20Token _connectorToken, bool _disable) public {
        disableReserveSale(_connectorToken, _disable);
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function getConnectorBalance(IERC20Token _connectorToken) public view returns (uint256) {
        return getReserveBalance(_connectorToken);
    }

    /**
      * @dev deprecated, backward compatibility
    */
    function getCrossConnectorReturn(IERC20Token _fromConnectorToken, IERC20Token _toConnectorToken, uint256 _amount) public view returns (uint256, uint256) {
        return getCrossReserveReturn(_fromConnectorToken, _toConnectorToken, _amount);
    }
}
