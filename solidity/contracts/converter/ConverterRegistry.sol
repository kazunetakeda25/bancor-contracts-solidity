pragma solidity 0.4.26;
import "../utility/TokenHandler.sol";
import "../utility/ContractRegistryClient.sol";
import "./interfaces/IConverter.sol";
import "./interfaces/IConverterFactory.sol";
import "./interfaces/IConverterRegistry.sol";
import "./interfaces/IConverterRegistryData.sol";

/**
  * @dev The ConverterRegistry maintains a list of all active converters in the Bancor Network.
  *
  * Since converters can be upgraded and thus their address can change, the registry actually keeps
  * converter anchors internally and not the converters themselves.
  * The active converter for each anchor can be easily accessed by querying the anchor's owner.
  *
  * The registry exposes 3 differnet lists that can be accessed and iterated, based on the use-case of the caller:
  * - anchors - can be used to get all the latest / historical data in the network
  * - Liquidity pools - can be used to get all liquidity pools for funding, liquidation etc.
  * - Convertible tokens - can be used to get all tokens that can be converted in the network (excluding pool
  *   tokens), and for each one - all anchors that hold it in their reserves
  *
  *
  * The contract fires events whenever one of the primitives is added to or removed from the registry
  *
  * The contract is upgradable.
*/
contract ConverterRegistry is IConverterRegistry, ContractRegistryClient, TokenHandler {
    address private constant ETH_RESERVE_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /**
      * @dev triggered when a converter anchor is added to the registry
      *
      * @param _anchor smart token
    */
    event ConverterAnchorAdded(address indexed _anchor);

    /**
      * @dev triggered when a converter anchor is removed from the registry
      *
      * @param _anchor smart token
    */
    event ConverterAnchorRemoved(address indexed _anchor);

    /**
      * @dev triggered when a liquidity pool is added to the registry
      *
      * @param _liquidityPool liquidity pool
    */
    event LiquidityPoolAdded(address indexed _liquidityPool);

    /**
      * @dev triggered when a liquidity pool is removed from the registry
      *
      * @param _liquidityPool liquidity pool
    */
    event LiquidityPoolRemoved(address indexed _liquidityPool);

    /**
      * @dev triggered when a convertible token is added to the registry
      *
      * @param _convertibleToken convertible token
      * @param _smartToken associated smart token
    */
    event ConvertibleTokenAdded(address indexed _convertibleToken, address indexed _smartToken);

    /**
      * @dev triggered when a convertible token is removed from the registry
      *
      * @param _convertibleToken convertible token
      * @param _smartToken associated smart token
    */
    event ConvertibleTokenRemoved(address indexed _convertibleToken, address indexed _smartToken);

    /**
      * @dev deprecated, backward compatibility, use `ConverterAnchorAdded`
    */
    event SmartTokenAdded(address indexed _smartToken);

    /**
      * @dev deprecated, backward compatibility, use `ConverterAnchorRemoved`
    */
    event SmartTokenRemoved(address indexed _smartToken);

    /**
      * @dev initializes a new ConverterRegistry instance
      *
      * @param _registry address of a contract registry contract
    */
    constructor(IContractRegistry _registry) ContractRegistryClient(_registry) public {
    }

    /**
      * @dev creates a zero supply liquid token / empty liquidity pool and adds its converter to the registry
      *
      * @param _type                converter type, see ConverterBase contract main doc
      * @param _name                token / pool name
      * @param _symbol              token / pool symbol
      * @param _decimals            token / pool decimals
      * @param _maxConversionFee    maximum conversion-fee
      * @param _reserveTokens       reserve tokens
      * @param _reserveWeights      reserve weights
      *
      * @return new converter
    */
    function newConverter(
        uint8 _type,
        string _name,
        string _symbol,
        uint8 _decimals,
        uint32 _maxConversionFee,
        IERC20Token[] memory _reserveTokens,
        uint32[] memory _reserveWeights
    )
    public returns (IConverter)
    {
        uint256 length = _reserveTokens.length;
        require(length == _reserveWeights.length, "ERR_INVALID_RESERVES");
        require(getLiquidityPoolByConfig(_type, _reserveTokens, _reserveWeights) == IConverterAnchor(0), "ERR_ALREADY_EXISTS");

        IConverterFactory factory = IConverterFactory(addressOf(CONVERTER_FACTORY));
        IConverterAnchor anchor = IConverterAnchor(factory.createAnchor(_type, _name, _symbol, _decimals));
        IConverter converter = IConverter(factory.createConverter(_type, anchor, registry, _maxConversionFee));

        anchor.acceptOwnership();
        converter.acceptOwnership();

        for (uint256 i = 0; i < length; i++)
            converter.addReserve(_reserveTokens[i], _reserveWeights[i]);

        anchor.transferOwnership(converter);
        converter.acceptAnchorOwnership();
        converter.transferOwnership(msg.sender);

        addConverterInternal(converter);
        return converter;
    }

    /**
      * @dev adds an existing converter to the registry
      * can only be called by the owner
      *
      * @param _converter converter
    */
    function addConverter(IConverter _converter) public ownerOnly {
        require(isConverterValid(_converter), "ERR_INVALID_CONVERTER");
        addConverterInternal(_converter);
    }

    /**
      * @dev removes a converter from the registry
      * anyone can remove an existing converter from the registry, as long as the converter is invalid
      * note that the owner can also remove valid converters
      *
      * @param _converter converter
    */
    function removeConverter(IConverter _converter) public {
        require(msg.sender == owner || !isConverterValid(_converter), "ERR_ACCESS_DENIED");
        removeConverterInternal(_converter);
    }

    /**
      * @dev returns the number of converter anchors in the registry
      *
      * @return number of anchors
    */
    function getAnchorCount() public view returns (uint) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getSmartTokenCount();
    }

    /**
      * @dev returns the list of converter anchors in the registry
      *
      * @return list of anchors
    */
    function getAnchors() public view returns (address[]) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getSmartTokens();
    }

    /**
      * @dev returns the converter anchor at a given index
      *
      * @param _index index
      * @return anchor at the given index
    */
    function getAnchor(uint _index) public view returns (address) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getSmartToken(_index);
    }

    /**
      * @dev checks whether or not a given value is a converter anchor
      *
      * @param _value value
      * @return true if the given value is an anchor, false if not
    */
    function isAnchor(address _value) public view returns (bool) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).isSmartToken(_value);
    }

    /**
      * @dev returns the number of liquidity pools in the registry
      *
      * @return number of liquidity pools
    */
    function getLiquidityPoolCount() public view returns (uint) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getLiquidityPoolCount();
    }

    /**
      * @dev returns the list of liquidity pools in the registry
      *
      * @return list of liquidity pools
    */
    function getLiquidityPools() public view returns (address[]) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getLiquidityPools();
    }

    /**
      * @dev returns the liquidity pool at a given index
      *
      * @param _index index
      * @return liquidity pool at the given index
    */
    function getLiquidityPool(uint _index) public view returns (address) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getLiquidityPool(_index);
    }

    /**
      * @dev checks whether or not a given value is a liquidity pool
      *
      * @param _value value
      * @return true if the given value is a liquidity pool, false if not
    */
    function isLiquidityPool(address _value) public view returns (bool) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).isLiquidityPool(_value);
    }

    /**
      * @dev returns the number of convertible tokens in the registry
      *
      * @return number of convertible tokens
    */
    function getConvertibleTokenCount() public view returns (uint) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleTokenCount();
    }

    /**
      * @dev returns the list of convertible tokens in the registry
      *
      * @return list of convertible tokens
    */
    function getConvertibleTokens() public view returns (address[]) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleTokens();
    }

    /**
      * @dev returns the convertible token at a given index
      *
      * @param _index index
      * @return convertible token at the given index
    */
    function getConvertibleToken(uint _index) public view returns (address) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleToken(_index);
    }

    /**
      * @dev checks whether or not a given value is a convertible token
      *
      * @param _value value
      * @return true if the given value is a convertible token, false if not
    */
    function isConvertibleToken(address _value) public view returns (bool) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).isConvertibleToken(_value);
    }

    /**
      * @dev returns the number of converter anchors associated with a given convertible token
      *
      * @param _convertibleToken convertible token
      * @return number of anchors associated with the given convertible token
    */
    function getConvertibleTokenAnchorCount(address _convertibleToken) public view returns (uint) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleTokenSmartTokenCount(_convertibleToken);
    }

    /**
      * @dev returns the list of aoncerter anchors associated with a given convertible token
      *
      * @param _convertibleToken convertible token
      * @return list of anchors associated with the given convertible token
    */
    function getConvertibleTokenAnchors(address _convertibleToken) public view returns (address[]) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleTokenSmartTokens(_convertibleToken);
    }

    /**
      * @dev returns the converter anchor associated with a given convertible token at a given index
      *
      * @param _index index
      * @return anchor associated with the given convertible token at the given index
    */
    function getConvertibleTokenAnchor(address _convertibleToken, uint _index) public view returns (address) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleTokenSmartToken(_convertibleToken, _index);
    }

    /**
      * @dev checks whether or not a given value is a converter anchor of a given convertible token
      *
      * @param _convertibleToken convertible token
      * @param _value value
      * @return true if the given value is an anchor of the given convertible token, false if not
    */
    function isConvertibleTokenAnchor(address _convertibleToken, address _value) public view returns (bool) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).isConvertibleTokenSmartToken(_convertibleToken, _value);
    }

    /**
      * @dev returns a list of converters for a given list of anchors
      * this is a utility function that can be used to reduce the number of calls to the contract
      *
      * @param _anchors list of converter anchors
      * @return list of converters
    */
    function getConvertersByAnchors(address[] _anchors) public view returns (address[]) {
        address[] memory converters = new address[](_anchors.length);

        for (uint i = 0; i < _anchors.length; i++)
            converters[i] = IConverterAnchor(_anchors[i]).owner();

        return converters;
    }

    /**
      * @dev checks whether or not a given converter is valid
      *
      * @param _converter converter
      * @return true if the given converter is valid, false if not
    */
    function isConverterValid(IConverter _converter) public view returns (bool) {
        // verify that the converter is active
        return _converter.token().owner() == address(_converter);
    }

    /**
      * @dev checks if a liquidity pool with given configuration is already registered
      *
      * @param _converter converter with specific configuration
      * @return if a liquidity pool with the same configuration is already registered
    */
    function isSimilarLiquidityPoolRegistered(IConverter _converter) public view returns (bool) {
        uint reserveTokenCount = _converter.connectorTokenCount();
        IERC20Token[] memory reserveTokens = new IERC20Token[](reserveTokenCount);
        uint32[] memory reserveWeights = new uint32[](reserveTokenCount);

        // get the reserve-configuration of the converter
        for (uint i = 0; i < reserveTokenCount; i++) {
            IERC20Token reserveToken = _converter.connectorTokens(i);
            reserveTokens[i] = reserveToken;
            reserveWeights[i] = getReserveWeight(_converter, reserveToken);
        }

        // return if a liquidity pool with the same configuration is already registered
        return getLiquidityPoolByConfig(_converter.converterType(), reserveTokens, reserveWeights) != IConverterAnchor(0);
    }

    /**
      * @dev searches for a liquidity pool with specific configuration
      *
      * @param _type            converter type, see ConverterBase contract main doc
      * @param _reserveTokens   reserve tokens
      * @param _reserveWeights  reserve weights
      * @return the liquidity pool, or zero if no such liquidity pool exists
    */
    function getLiquidityPoolByConfig(uint8 _type, IERC20Token[] memory _reserveTokens, uint32[] memory _reserveWeights) public view returns (IConverterAnchor) {
        // verify that the input parameters represent a valid liquidity pool
        if (_reserveTokens.length == _reserveWeights.length && _reserveTokens.length > 1) {
            // get the anchors of the least frequent token (optimization)
            address[] memory convertibleTokenAnchors = getLeastFrequentTokenAnchors(_reserveTokens);
            // search for a converter with the same configuration
            for (uint i = 0; i < convertibleTokenAnchors.length; i++) {
                IConverterAnchor anchor = IConverterAnchor(convertibleTokenAnchors[i]);
                IConverter converter = IConverter(anchor.owner());
                if (isConverterReserveConfigEqual(converter, _type, _reserveTokens, _reserveWeights))
                    return anchor;
            }
        }

        return IConverterAnchor(0);
    }

    /**
      * @dev adds a converter anchor to the registry
      *
      * @param _anchor converter anchor
    */
    function addAnchor(IConverterRegistryData _converterRegistryData, address _anchor) internal {
        _converterRegistryData.addSmartToken(_anchor);
        emit ConverterAnchorAdded(_anchor);
        emit SmartTokenAdded(_anchor);
    }

    /**
      * @dev removes a converter anchor from the registry
      *
      * @param _anchor converter anchor
    */
    function removeAnchor(IConverterRegistryData _converterRegistryData, address _anchor) internal {
        _converterRegistryData.removeSmartToken(_anchor);
        emit ConverterAnchorRemoved(_anchor);
        emit SmartTokenRemoved(_anchor);
    }

    /**
      * @dev adds a liquidity pool to the registry
      *
      * @param _liquidityPool liquidity pool
    */
    function addLiquidityPool(IConverterRegistryData _converterRegistryData, address _liquidityPool) internal {
        _converterRegistryData.addLiquidityPool(_liquidityPool);
        emit LiquidityPoolAdded(_liquidityPool);
    }

    /**
      * @dev removes a liquidity pool from the registry
      *
      * @param _liquidityPool liquidity pool
    */
    function removeLiquidityPool(IConverterRegistryData _converterRegistryData, address _liquidityPool) internal {
        _converterRegistryData.removeLiquidityPool(_liquidityPool);
        emit LiquidityPoolRemoved(_liquidityPool);
    }

    /**
      * @dev adds a convertible token to the registry
      *
      * @param _convertibleToken    convertible token
      * @param _anchor              associated converter anchor
    */
    function addConvertibleToken(IConverterRegistryData _converterRegistryData, address _convertibleToken, address _anchor) internal {
        _converterRegistryData.addConvertibleToken(_convertibleToken, _anchor);
        emit ConvertibleTokenAdded(_convertibleToken, _anchor);
    }

    /**
      * @dev removes a convertible token from the registry
      *
      * @param _convertibleToken    convertible token
      * @param _anchor              associated converter anchor
    */
    function removeConvertibleToken(IConverterRegistryData _converterRegistryData, address _convertibleToken, address _anchor) internal {
        _converterRegistryData.removeConvertibleToken(_convertibleToken, _anchor);
        emit ConvertibleTokenRemoved(_convertibleToken, _anchor);
    }

    function addConverterInternal(IConverter _converter) private {
        IConverterRegistryData converterRegistryData = IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA));
        IConverterAnchor anchor = IConverter(_converter).token();
        uint reserveTokenCount = _converter.connectorTokenCount();

        // add the converter anchor
        addAnchor(converterRegistryData, anchor);
        if (reserveTokenCount > 1)
            addLiquidityPool(converterRegistryData, anchor);
        else
            addConvertibleToken(converterRegistryData, anchor, anchor);

        // add all reserve tokens
        for (uint i = 0; i < reserveTokenCount; i++)
            addConvertibleToken(converterRegistryData, _converter.connectorTokens(i), anchor);
    }

    function removeConverterInternal(IConverter _converter) private {
        IConverterRegistryData converterRegistryData = IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA));
        IConverterAnchor anchor = IConverter(_converter).anchor();
        uint reserveTokenCount = _converter.connectorTokenCount();

        // remove the converter anchor
        removeAnchor(converterRegistryData, anchor);
        if (reserveTokenCount > 1)
            removeLiquidityPool(converterRegistryData, anchor);
        else
            removeConvertibleToken(converterRegistryData, anchor, anchor);

        // remove all reserve tokens
        for (uint i = 0; i < reserveTokenCount; i++)
            removeConvertibleToken(converterRegistryData, _converter.connectorTokens(i), anchor);
    }

    function getLeastFrequentTokenAnchors(IERC20Token[] memory _reserveTokens) private view returns (address[] memory) {
        IConverterRegistryData converterRegistryData = IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA));
        uint minAnchorCount = converterRegistryData.getConvertibleTokenSmartTokenCount(_reserveTokens[0]);
        uint index = 0;

        // find the reserve token which has the smallest number of converter anchors
        for (uint i = 1; i < _reserveTokens.length; i++) {
            uint convertibleTokenAnchorCount = converterRegistryData.getConvertibleTokenSmartTokenCount(_reserveTokens[i]);
            if (minAnchorCount > convertibleTokenAnchorCount) {
                minAnchorCount = convertibleTokenAnchorCount;
                index = i;
            }
        }

        return converterRegistryData.getConvertibleTokenSmartTokens(_reserveTokens[index]);
    }

    function isConverterReserveConfigEqual(IConverter _converter, uint8 _type, IERC20Token[] memory _reserveTokens, uint32[] memory _reserveWeights) private view returns (bool) {
        if (_type != _converter.converterType())
            return false;

        if (_reserveTokens.length != _converter.connectorTokenCount())
            return false;

        for (uint i = 0; i < _reserveTokens.length; i++) {
            if (_reserveWeights[i] != getReserveWeight(_converter, _reserveTokens[i]))
                return false;
        }

        return true;
    }

    bytes4 private constant CONNECTORS_FUNC_SELECTOR = bytes4(keccak256("connectors(address)"));

    function getReserveWeight(address _converter, address _reserveToken) private view returns (uint32) {
        uint256[2] memory ret;
        bytes memory data = abi.encodeWithSelector(CONNECTORS_FUNC_SELECTOR, _reserveToken);

        assembly {
            let success := staticcall(
                gas,           // gas remaining
                _converter,    // destination address
                add(data, 32), // input buffer (starts after the first 32 bytes in the `data` array)
                mload(data),   // input length (loaded from the first 32 bytes in the `data` array)
                ret,           // output buffer
                64             // output length
            )
            if iszero(success) {
                revert(0, 0)
            }
        }

        return uint32(ret[1]);
    }

    /**
      * @dev deprecated, backward compatibility, use `getAnchorCount`
    */
    function getSmartTokenCount() public view returns (uint) {
        return getAnchorCount();
    }

    /**
      * @dev deprecated, backward compatibility, use `getAnchors`
    */
    function getSmartTokens() public view returns (address[]) {
        return getAnchors();
    }

    /**
      * @dev deprecated, backward compatibility, use `getAnchor`
    */
    function getSmartToken(uint _index) public view returns (address) {
        return getAnchor(_index);
    }

    /**
      * @dev deprecated, backward compatibility, use `isAnchor`
    */
    function isSmartToken(address _value) public view returns (bool) {
        return isAnchor(_value);
    }

    /**
      * @dev deprecated, backward compatibility, use `getConvertibleTokenAnchorCount`
    */
    function getConvertibleTokenSmartTokenCount(address _convertibleToken) public view returns (uint) {
        return getConvertibleTokenAnchorCount(_convertibleToken);
    }

    /**
      * @dev deprecated, backward compatibility, use `getConvertibleTokenAnchors`
    */
    function getConvertibleTokenSmartTokens(address _convertibleToken) public view returns (address[]) {
        return getConvertibleTokenAnchors(_convertibleToken);
    }

    /**
      * @dev deprecated, backward compatibility, use `getConvertibleTokenAnchor`
    */
    function getConvertibleTokenSmartToken(address _convertibleToken, uint _index) public view returns (address) {
        return getConvertibleTokenAnchor(_convertibleToken, _index);
    }

    /**
      * @dev deprecated, backward compatibility, use `isConvertibleTokenAnchor`
    */
    function isConvertibleTokenSmartToken(address _convertibleToken, address _value) public view returns (bool) {
        return isConvertibleTokenAnchor(_convertibleToken, _value);
    }

    /**
      * @dev deprecated, backward compatibility, use `getConvertersByAnchors`
    */
    function getConvertersBySmartTokens(address[] _smartTokens) public view returns (address[]) {
        return getConvertersByAnchors(_smartTokens);
    }

    /**
      * @dev deprecated, backward compatibility, use `getLiquidityPoolByConfig`
    */
    function getLiquidityPoolByReserveConfig(IERC20Token[] memory _reserveTokens, uint32[] memory _reserveWeights) public view returns (IConverterAnchor) {
        return getLiquidityPoolByConfig(1, _reserveTokens, _reserveWeights);
    }
}
