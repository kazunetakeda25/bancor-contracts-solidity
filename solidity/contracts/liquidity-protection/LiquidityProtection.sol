// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "@bancor/token-governance/contracts/ITokenGovernance.sol";

import "../utility/interfaces/ICheckpointStore.sol";
import "../utility/MathEx.sol";
import "../utility/ReentrancyGuard.sol";
import "../utility/Types.sol";
import "../utility/Time.sol";
import "../utility/Utils.sol";
import "../utility/Owned.sol";

import "../token/interfaces/IDSToken.sol";
import "../converter/interfaces/IConverterAnchor.sol";
import "../converter/interfaces/IConverter.sol";
import "../converter/interfaces/IConverterRegistry.sol";

import "./interfaces/ILiquidityProtection.sol";

interface ILiquidityPoolConverter is IConverter {
    function addLiquidity(
        IERC20[] memory reserveTokens,
        uint256[] memory reserveAmounts,
        uint256 _minReturn
    ) external payable;

    function removeLiquidity(
        uint256 amount,
        IERC20[] memory reserveTokens,
        uint256[] memory _reserveMinReturnAmounts
    ) external;

    function recentAverageRate(IERC20 reserveToken) external view returns (uint256, uint256);
}

/**
 * @dev This contract implements the liquidity protection mechanism.
 */
contract LiquidityProtection is ILiquidityProtection, Utils, Owned, ReentrancyGuard, Time {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for IDSToken;
    using MathEx for *;

    struct ProtectedLiquidity {
        address provider; // liquidity provider
        IDSToken poolToken; // pool token address
        IERC20 reserveToken; // reserve token address
        uint256 poolAmount; // pool token amount
        uint256 reserveAmount; // reserve token amount
        uint256 reserveRateN; // rate of 1 protected reserve token in units of the other reserve token (numerator)
        uint256 reserveRateD; // rate of 1 protected reserve token in units of the other reserve token (denominator)
        uint256 timestamp; // timestamp
    }

    // various rates between the two reserve tokens. the rate is of 1 unit of the protected reserve token in units of the other reserve token
    struct PackedRates {
        uint128 addSpotRateN; // spot rate of 1 A in units of B when liquidity was added (numerator)
        uint128 addSpotRateD; // spot rate of 1 A in units of B when liquidity was added (denominator)
        uint128 removeSpotRateN; // spot rate of 1 A in units of B when liquidity is removed (numerator)
        uint128 removeSpotRateD; // spot rate of 1 A in units of B when liquidity is removed (denominator)
        uint128 removeAverageRateN; // average rate of 1 A in units of B when liquidity is removed (numerator)
        uint128 removeAverageRateD; // average rate of 1 A in units of B when liquidity is removed (denominator)
    }

    uint256 internal constant MAX_UINT128 = 2**128 - 1;
    uint256 internal constant MAX_UINT256 = uint256(-1);

    ILiquidityProtectionSettings private immutable _settings;
    ILiquidityProtectionStore private immutable _store;
    ILiquidityProtectionStats private immutable _stats;
    ILiquidityProtectionSystemStore private immutable _systemStore;
    ITokenHolder private immutable _wallet;
    IERC20 private immutable _networkToken;
    ITokenGovernance private immutable _networkTokenGovernance;
    IERC20 private immutable _govToken;
    ITokenGovernance private immutable _govTokenGovernance;
    ICheckpointStore private immutable _lastRemoveCheckpointStore;

    /**
     * @dev initializes a new LiquidityProtection contract
     *
     * @param settings liquidity protection settings
     * @param store liquidity protection store
     * @param stats liquidity protection stats
     * @param systemStore liquidity protection system store
     * @param wallet liquidity protection wallet
     * @param networkTokenGovernance network token governance
     * @param govTokenGovernance governance token governance
     * @param lastRemoveCheckpointStore last liquidity removal/unprotection checkpoints store
     */
    constructor(
        ILiquidityProtectionSettings settings,
        ILiquidityProtectionStore store,
        ILiquidityProtectionStats stats,
        ILiquidityProtectionSystemStore systemStore,
        ITokenHolder wallet,
        ITokenGovernance networkTokenGovernance,
        ITokenGovernance govTokenGovernance,
        ICheckpointStore lastRemoveCheckpointStore
    )
        public
        validAddress(address(settings))
        validAddress(address(store))
        validAddress(address(stats))
        validAddress(address(systemStore))
        validAddress(address(wallet))
        validAddress(address(lastRemoveCheckpointStore))
    {
        _settings = settings;
        _store = store;
        _stats = stats;
        _systemStore = systemStore;
        _wallet = wallet;
        _networkTokenGovernance = networkTokenGovernance;
        _govTokenGovernance = govTokenGovernance;
        _lastRemoveCheckpointStore = lastRemoveCheckpointStore;

        _networkToken = networkTokenGovernance.token();
        _govToken = govTokenGovernance.token();
    }

    // ensures that the pool is supported and whitelisted
    modifier poolSupportedAndWhitelisted(IConverterAnchor poolAnchor) {
        _poolSupported(poolAnchor);
        _poolWhitelisted(poolAnchor);

        _;
    }

    // ensures that add liquidity is enabled
    modifier addLiquidityEnabled(IConverterAnchor poolAnchor, IERC20 reserveToken) {
        _addLiquidityEnabled(poolAnchor, reserveToken);

        _;
    }

    // error message binary size optimization
    function _poolSupported(IConverterAnchor poolAnchor) internal view {
        require(_settings.isPoolSupported(poolAnchor), "ERR_POOL_NOT_SUPPORTED");
    }

    // error message binary size optimization
    function _poolWhitelisted(IConverterAnchor poolAnchor) internal view {
        require(_settings.isPoolWhitelisted(poolAnchor), "ERR_POOL_NOT_WHITELISTED");
    }

    // error message binary size optimization
    function _addLiquidityEnabled(IConverterAnchor poolAnchor, IERC20 reserveToken) internal view {
        require(!_settings.addLiquidityDisabled(poolAnchor, reserveToken), "ERR_ADD_LIQUIDITY_DISABLED");
    }

    // error message binary size optimization
    function verifyEthAmount(uint256 value) internal view {
        require(msg.value == value, "ERR_ETH_AMOUNT_MISMATCH");
    }

    /**
     * @dev returns the LP store
     *
     * @return the LP store
     */
    function store() external view override returns (ILiquidityProtectionStore) {
        return _store;
    }

    /**
     * @dev returns the LP stats
     *
     * @return the LP stats
     */
    function stats() external view override returns (ILiquidityProtectionStats) {
        return _stats;
    }

    /**
     * @dev returns the LP settings
     *
     * @return the LP settings
     */
    function settings() external view override returns (ILiquidityProtectionSettings) {
        return _settings;
    }

    /**
     * @dev returns the LP system store
     *
     * @return the LP settings
     */
    function systemStore() external view override returns (ILiquidityProtectionSystemStore) {
        return _systemStore;
    }

    /**
     * @dev returns the LP wallet
     *
     * @return the LP wallet
     */
    function wallet() external view override returns (ITokenHolder) {
        return _wallet;
    }

    /**
     * @dev accept ETH
     */
    receive() external payable {}

    /**
     * @dev transfers the ownership of the store
     * can only be called by the contract owner
     *
     * @param newOwner the new owner of the store
     */
    function transferStoreOwnership(address newOwner) external ownerOnly {
        _store.transferOwnership(newOwner);
    }

    /**
     * @dev accepts the ownership of the store
     * can only be called by the contract owner
     */
    function acceptStoreOwnership() external ownerOnly {
        _store.acceptOwnership();
    }

    /**
     * @dev transfers the ownership of the wallet
     * can only be called by the contract owner
     *
     * @param newOwner the new owner of the wallet
     */
    function transferWalletOwnership(address newOwner) external ownerOnly {
        _wallet.transferOwnership(newOwner);
    }

    /**
     * @dev accepts the ownership of the wallet
     * can only be called by the contract owner
     */
    function acceptWalletOwnership() external ownerOnly {
        _wallet.acceptOwnership();
    }

    /**
     * @dev adds protected liquidity to a pool for a specific recipient
     * also mints new governance tokens for the caller if the caller adds network tokens
     *
     * @param owner protected liquidity owner
     * @param poolAnchor anchor of the pool
     * @param reserveToken reserve token to add to the pool
     * @param amount amount of tokens to add to the pool
     *
     * @return new protected liquidity id
     */
    function addLiquidityFor(
        address owner,
        IConverterAnchor poolAnchor,
        IERC20 reserveToken,
        uint256 amount
    )
        external
        payable
        override
        protected
        validAddress(owner)
        poolSupportedAndWhitelisted(poolAnchor)
        addLiquidityEnabled(poolAnchor, reserveToken)
        greaterThanZero(amount)
        returns (uint256)
    {
        return addLiquidity(owner, poolAnchor, reserveToken, amount);
    }

    /**
     * @dev adds protected liquidity to a pool
     * also mints new governance tokens for the caller if the caller adds network tokens
     *
     * @param poolAnchor anchor of the pool
     * @param reserveToken reserve token to add to the pool
     * @param amount amount of tokens to add to the pool
     *
     * @return new protected liquidity id
     */
    function addLiquidity(
        IConverterAnchor poolAnchor,
        IERC20 reserveToken,
        uint256 amount
    )
        external
        payable
        override
        protected
        poolSupportedAndWhitelisted(poolAnchor)
        addLiquidityEnabled(poolAnchor, reserveToken)
        greaterThanZero(amount)
        returns (uint256)
    {
        return addLiquidity(msg.sender, poolAnchor, reserveToken, amount);
    }

    /**
     * @dev adds protected liquidity to a pool for a specific recipient
     * also mints new governance tokens for the caller if the caller adds network tokens
     *
     * @param owner protected liquidity owner
     * @param poolAnchor anchor of the pool
     * @param reserveToken reserve token to add to the pool
     * @param amount amount of tokens to add to the pool
     *
     * @return new protected liquidity id
     */
    function addLiquidity(
        address owner,
        IConverterAnchor poolAnchor,
        IERC20 reserveToken,
        uint256 amount
    ) private returns (uint256) {
        if (reserveToken == _networkToken) {
            verifyEthAmount(0);
            return addNetworkTokenLiquidity(owner, poolAnchor, amount);
        }

        // verify that ETH was passed with the call if needed
        verifyEthAmount(reserveToken == NATIVE_TOKEN_ADDRESS ? amount : 0);
        return addBaseTokenLiquidity(owner, poolAnchor, reserveToken, amount);
    }

    /**
     * @dev adds protected network token liquidity to a pool
     * also mints new governance tokens for the caller
     *
     * @param owner protected liquidity owner
     * @param poolAnchor anchor of the pool
     * @param amount amount of tokens to add to the pool
     *
     * @return new protected liquidity id
     */
    function addNetworkTokenLiquidity(
        address owner,
        IConverterAnchor poolAnchor,
        uint256 amount
    ) internal returns (uint256) {
        IDSToken poolToken = IDSToken(address(poolAnchor));

        // get the rate between the pool token and the reserve
        Fraction memory poolRate = poolTokenRate(poolToken, _networkToken);

        // calculate the amount of pool tokens based on the amount of reserve tokens
        uint256 poolTokenAmount = amount.mul(poolRate.d).div(poolRate.n);

        // remove the pool tokens from the system's ownership (will revert if not enough tokens are available)
        _systemStore.decSystemBalance(poolToken, poolTokenAmount);

        // add protected liquidity for the recipient
        uint256 id = addProtectedLiquidity(owner, poolToken, _networkToken, poolTokenAmount, amount);

        // burns the network tokens from the caller. we need to transfer the tokens to the contract itself, since only
        // token holders can burn their tokens
        _networkToken.safeTransferFrom(msg.sender, address(this), amount);
        burnNetworkTokens(poolAnchor, amount);

        // mint governance tokens to the recipient
        _govTokenGovernance.mint(owner, amount);

        return id;
    }

    /**
     * @dev adds protected base token liquidity to a pool
     *
     * @param owner protected liquidity owner
     * @param poolAnchor anchor of the pool
     * @param baseToken the base reserve token of the pool
     * @param amount amount of tokens to add to the pool
     *
     * @return new protected liquidity id
     */
    function addBaseTokenLiquidity(
        address owner,
        IConverterAnchor poolAnchor,
        IERC20 baseToken,
        uint256 amount
    ) internal returns (uint256) {
        IDSToken poolToken = IDSToken(address(poolAnchor));

        // get the reserve balances
        ILiquidityPoolConverter converter = ILiquidityPoolConverter(payable(ownedBy(poolAnchor)));
        (uint256 reserveBalanceBase, uint256 reserveBalanceNetwork) =
            converterReserveBalances(converter, baseToken, _networkToken);

        require(reserveBalanceNetwork >= _settings.minNetworkTokenLiquidityForMinting(), "ERR_NOT_ENOUGH_LIQUIDITY");

        // calculate and mint the required amount of network tokens for adding liquidity
        uint256 newNetworkLiquidityAmount = amount.mul(reserveBalanceNetwork).div(reserveBalanceBase);

        // verify network token minting limit
        uint256 mintingLimit = _settings.networkTokenMintingLimits(poolAnchor);
        if (mintingLimit == 0) {
            mintingLimit = _settings.defaultNetworkTokenMintingLimit();
        }

        uint256 newNetworkTokensMinted = _systemStore.networkTokensMinted(poolAnchor).add(newNetworkLiquidityAmount);
        require(newNetworkTokensMinted <= mintingLimit, "ERR_MAX_AMOUNT_REACHED");

        // issue new network tokens to the system
        mintNetworkTokens(address(this), poolAnchor, newNetworkLiquidityAmount);

        // transfer the base tokens from the caller and approve the converter
        ensureAllowance(_networkToken, address(converter), newNetworkLiquidityAmount);
        if (baseToken != NATIVE_TOKEN_ADDRESS) {
            baseToken.safeTransferFrom(msg.sender, address(this), amount);
            ensureAllowance(baseToken, address(converter), amount);
        }

        // add liquidity
        addLiquidity(converter, baseToken, _networkToken, amount, newNetworkLiquidityAmount, msg.value);

        // transfer the new pool tokens to the wallet
        uint256 poolTokenAmount = poolToken.balanceOf(address(this));
        poolToken.safeTransfer(address(_wallet), poolTokenAmount);

        // the system splits the pool tokens with the caller
        // increase the system's pool token balance and add protected liquidity for the caller
        _systemStore.incSystemBalance(poolToken, poolTokenAmount - poolTokenAmount / 2); // account for rounding errors
        return addProtectedLiquidity(owner, poolToken, baseToken, poolTokenAmount / 2, amount);
    }

    /**
     * @dev returns the single-side staking limits of a given pool
     *
     * @param poolAnchor anchor of the pool
     *
     * @return maximum amount of base tokens that can be single-side staked in the pool
     * @return maximum amount of network tokens that can be single-side staked in the pool
     */
    function poolAvailableSpace(IConverterAnchor poolAnchor)
        external
        view
        poolSupportedAndWhitelisted(poolAnchor)
        returns (uint256, uint256)
    {
        return (baseTokenAvailableSpace(poolAnchor), networkTokenAvailableSpace(poolAnchor));
    }

    /**
     * @dev returns the base-token staking limits of a given pool
     *
     * @param poolAnchor anchor of the pool
     *
     * @return maximum amount of base tokens that can be single-side staked in the pool
     */
    function baseTokenAvailableSpace(IConverterAnchor poolAnchor) internal view returns (uint256) {
        // get the pool converter
        ILiquidityPoolConverter converter = ILiquidityPoolConverter(payable(ownedBy(poolAnchor)));

        // get the base token
        IERC20 baseToken = converterOtherReserve(converter, _networkToken);

        // get the reserve balances
        (uint256 reserveBalanceBase, uint256 reserveBalanceNetwork) =
            converterReserveBalances(converter, baseToken, _networkToken);

        // get the network token minting limit
        uint256 mintingLimit = _settings.networkTokenMintingLimits(poolAnchor);
        if (mintingLimit == 0) {
            mintingLimit = _settings.defaultNetworkTokenMintingLimit();
        }

        // get the amount of network tokens already minted for the pool
        uint256 networkTokensMinted = _systemStore.networkTokensMinted(poolAnchor);

        // get the amount of network tokens which can minted for the pool
        uint256 networkTokensCanBeMinted = MathEx.max(mintingLimit, networkTokensMinted) - networkTokensMinted;

        // return the maximum amount of base token liquidity that can be single-sided staked in the pool
        return networkTokensCanBeMinted.mul(reserveBalanceBase).div(reserveBalanceNetwork);
    }

    /**
     * @dev returns the network-token staking limits of a given pool
     *
     * @param poolAnchor anchor of the pool
     *
     * @return maximum amount of network tokens that can be single-side staked in the pool
     */
    function networkTokenAvailableSpace(IConverterAnchor poolAnchor) internal view returns (uint256) {
        // get the pool token
        IDSToken poolToken = IDSToken(address(poolAnchor));

        // get the pool token rate
        Fraction memory poolRate = poolTokenRate(poolToken, _networkToken);

        // return the maximum amount of network token liquidity that can be single-sided staked in the pool
        return _systemStore.systemBalance(poolToken).mul(poolRate.n).add(poolRate.n).sub(1).div(poolRate.d);
    }

    /**
     * @dev returns the expected/actual amounts the provider will receive for removing liquidity
     * it's also possible to provide the remove liquidity time to get an estimation
     * for the return at that given point
     *
     * @param id protected liquidity id
     * @param portion portion of liquidity to remove, in PPM
     * @param removeTimestamp time at which the liquidity is removed
     *
     * @return expected return amount in the reserve token
     * @return actual return amount in the reserve token
     * @return compensation in the network token
     */
    function removeLiquidityReturn(
        uint256 id,
        uint32 portion,
        uint256 removeTimestamp
    )
        external
        view
        validPortion(portion)
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        ProtectedLiquidity memory liquidity = protectedLiquidity(id);

        // verify input
        require(liquidity.provider != address(0), "ERR_INVALID_ID");
        require(removeTimestamp >= liquidity.timestamp, "ERR_INVALID_TIMESTAMP");

        // calculate the portion of the liquidity to remove
        if (portion != PPM_RESOLUTION) {
            liquidity.poolAmount = liquidity.poolAmount.mul(portion) / PPM_RESOLUTION;
            liquidity.reserveAmount = liquidity.reserveAmount.mul(portion) / PPM_RESOLUTION;
        }

        // get the various rates between the reserves upon adding liquidity and now
        PackedRates memory packedRates =
            packRates(
                liquidity.poolToken,
                liquidity.reserveToken,
                liquidity.reserveRateN,
                liquidity.reserveRateD,
                false
            );

        uint256 targetAmount =
            removeLiquidityTargetAmount(
                liquidity.poolToken,
                liquidity.reserveToken,
                liquidity.poolAmount,
                liquidity.reserveAmount,
                packedRates,
                liquidity.timestamp,
                removeTimestamp
            );

        // for network token, the return amount is identical to the target amount
        if (liquidity.reserveToken == _networkToken) {
            return (targetAmount, targetAmount, 0);
        }

        // handle base token return

        // calculate the amount of pool tokens required for liquidation
        // note that the amount is doubled since it's not possible to liquidate one reserve only
        Fraction memory poolRate = poolTokenRate(liquidity.poolToken, liquidity.reserveToken);
        uint256 poolAmount = targetAmount.mul(poolRate.d).div(poolRate.n / 2);

        // limit the amount of pool tokens by the amount the system/caller holds
        uint256 availableBalance = _systemStore.systemBalance(liquidity.poolToken).add(liquidity.poolAmount);
        poolAmount = poolAmount > availableBalance ? availableBalance : poolAmount;

        // calculate the base token amount received by liquidating the pool tokens
        // note that the amount is divided by 2 since the pool amount represents both reserves
        uint256 baseAmount = poolAmount.mul(poolRate.n / 2).div(poolRate.d);
        uint256 networkAmount = networkCompensation(targetAmount, baseAmount, packedRates);

        return (targetAmount, baseAmount, networkAmount);
    }

    /**
     * @dev removes protected liquidity from a pool
     * also burns governance tokens from the caller if the caller removes network tokens
     *
     * @param id id in the caller's list of protected liquidity
     * @param portion portion of liquidity to remove, in PPM
     */
    function removeLiquidity(uint256 id, uint32 portion) external override protected validPortion(portion) {
        removeLiquidity(msg.sender, id, portion);
    }

    /**
     * @dev removes protected liquidity from a pool
     * also burns governance tokens from the caller if the caller removes network tokens
     *
     * @param provider protected liquidity provider
     * @param id id in the caller's list of protected liquidity
     * @param portion portion of liquidity to remove, in PPM
     */
    function removeLiquidity(
        address payable provider,
        uint256 id,
        uint32 portion
    ) internal {
        ProtectedLiquidity memory liquidity = protectedLiquidity(id, provider);

        // verify that the pool is whitelisted
        _poolWhitelisted(liquidity.poolToken);

        // verify that the protected liquidity is not removed on the same block in which it was added
        require(liquidity.timestamp < time(), "ERR_TOO_EARLY");

        if (portion == PPM_RESOLUTION) {
            // notify event subscribers
            notifyEventSubscribersOnRemovingLiquidity(
                id,
                provider,
                liquidity.poolToken,
                liquidity.reserveToken,
                liquidity.poolAmount,
                liquidity.reserveAmount
            );

            // remove the protected liquidity from the provider
            _store.removeProtectedLiquidity(id);
        } else {
            // remove a portion of the protected liquidity from the provider
            uint256 fullPoolAmount = liquidity.poolAmount;
            uint256 fullReserveAmount = liquidity.reserveAmount;
            liquidity.poolAmount = liquidity.poolAmount.mul(portion) / PPM_RESOLUTION;
            liquidity.reserveAmount = liquidity.reserveAmount.mul(portion) / PPM_RESOLUTION;

            // notify event subscribers
            notifyEventSubscribersOnRemovingLiquidity(
                id,
                provider,
                liquidity.poolToken,
                liquidity.reserveToken,
                liquidity.poolAmount,
                liquidity.reserveAmount
            );

            _store.updateProtectedLiquidityAmounts(
                id,
                fullPoolAmount - liquidity.poolAmount,
                fullReserveAmount - liquidity.reserveAmount
            );
        }

        // update the statistics
        _stats.decreaseTotalAmounts(
            liquidity.provider,
            liquidity.poolToken,
            liquidity.reserveToken,
            liquidity.poolAmount,
            liquidity.reserveAmount
        );

        // update last liquidity removal checkpoint
        _lastRemoveCheckpointStore.addCheckpoint(provider);

        // add the pool tokens to the system
        _systemStore.incSystemBalance(liquidity.poolToken, liquidity.poolAmount);

        // if removing network token liquidity, burn the governance tokens from the caller. we need to transfer the
        // tokens to the contract itself, since only token holders can burn their tokens
        if (liquidity.reserveToken == _networkToken) {
            _govToken.safeTransferFrom(provider, address(this), liquidity.reserveAmount);
            _govTokenGovernance.burn(liquidity.reserveAmount);
        }

        // get the various rates between the reserves upon adding liquidity and now
        PackedRates memory packedRates =
            packRates(
                liquidity.poolToken,
                liquidity.reserveToken,
                liquidity.reserveRateN,
                liquidity.reserveRateD,
                true
            );

        // get the target token amount
        uint256 targetAmount =
            removeLiquidityTargetAmount(
                liquidity.poolToken,
                liquidity.reserveToken,
                liquidity.poolAmount,
                liquidity.reserveAmount,
                packedRates,
                liquidity.timestamp,
                time()
            );

        // remove network token liquidity
        if (liquidity.reserveToken == _networkToken) {
            // mint network tokens for the caller and lock them
            mintNetworkTokens(address(_wallet), liquidity.poolToken, targetAmount);
            lockTokens(provider, targetAmount);
            return;
        }

        // remove base token liquidity

        // calculate the amount of pool tokens required for liquidation
        // note that the amount is doubled since it's not possible to liquidate one reserve only
        Fraction memory poolRate = poolTokenRate(liquidity.poolToken, liquidity.reserveToken);
        uint256 poolAmount = targetAmount.mul(poolRate.d).div(poolRate.n / 2);

        // limit the amount of pool tokens by the amount the system holds
        uint256 systemBalance = _systemStore.systemBalance(liquidity.poolToken);
        poolAmount = poolAmount > systemBalance ? systemBalance : poolAmount;

        // withdraw the pool tokens from the wallet
        _systemStore.decSystemBalance(liquidity.poolToken, poolAmount);
        _wallet.withdrawTokens(liquidity.poolToken, address(this), poolAmount);

        // remove liquidity
        removeLiquidity(liquidity.poolToken, poolAmount, liquidity.reserveToken, _networkToken);

        // transfer the base tokens to the caller
        uint256 baseBalance;
        if (liquidity.reserveToken == NATIVE_TOKEN_ADDRESS) {
            baseBalance = address(this).balance;
            provider.transfer(baseBalance);
        } else {
            baseBalance = liquidity.reserveToken.balanceOf(address(this));
            liquidity.reserveToken.safeTransfer(provider, baseBalance);
        }

        // compensate the caller with network tokens if still needed
        uint256 delta = networkCompensation(targetAmount, baseBalance, packedRates);
        if (delta > 0) {
            // check if there's enough network token balance, otherwise mint more
            uint256 networkBalance = _networkToken.balanceOf(address(this));
            if (networkBalance < delta) {
                _networkTokenGovernance.mint(address(this), delta - networkBalance);
            }

            // lock network tokens for the caller
            _networkToken.safeTransfer(address(_wallet), delta);
            lockTokens(provider, delta);
        }

        // if the contract still holds network tokens, burn them
        uint256 networkBalance = _networkToken.balanceOf(address(this));
        if (networkBalance > 0) {
            burnNetworkTokens(liquidity.poolToken, networkBalance);
        }
    }

    /**
     * @dev returns the amount the provider will receive for removing liquidity
     * it's also possible to provide the remove liquidity rate & time to get an estimation
     * for the return at that given point
     *
     * @param poolToken pool token
     * @param reserveToken reserve token
     * @param poolAmount pool token amount when the liquidity was added
     * @param reserveAmount reserve token amount that was added
     * @param packedRates see `struct PackedRates`
     * @param addTimestamp time at which the liquidity was added
     * @param removeTimestamp time at which the liquidity is removed
     *
     * @return amount received for removing liquidity
     */
    function removeLiquidityTargetAmount(
        IDSToken poolToken,
        IERC20 reserveToken,
        uint256 poolAmount,
        uint256 reserveAmount,
        PackedRates memory packedRates,
        uint256 addTimestamp,
        uint256 removeTimestamp
    ) internal view returns (uint256) {
        // get the rate between the pool token and the reserve token
        Fraction memory poolRate = poolTokenRate(poolToken, reserveToken);

        // get the rate between the reserves upon adding liquidity and now
        Fraction memory addSpotRate = Fraction({ n: packedRates.addSpotRateN, d: packedRates.addSpotRateD });
        Fraction memory removeSpotRate = Fraction({ n: packedRates.removeSpotRateN, d: packedRates.removeSpotRateD });
        Fraction memory removeAverageRate =
            Fraction({ n: packedRates.removeAverageRateN, d: packedRates.removeAverageRateD });

        // calculate the protected amount of reserve tokens plus accumulated fee before compensation
        uint256 total = protectedAmountPlusFee(poolAmount, poolRate, addSpotRate, removeSpotRate);

        // calculate the impermanent loss
        Fraction memory loss = impLoss(addSpotRate, removeAverageRate);

        // calculate the protection level
        Fraction memory level = protectionLevel(addTimestamp, removeTimestamp);

        // calculate the compensation amount
        return compensationAmount(reserveAmount, MathEx.max(reserveAmount, total), loss, level);
    }

    /**
     * @dev allows the caller to claim network token balance that is no longer locked
     * note that the function can revert if the range is too large
     *
     * @param startIndex start index in the caller's list of locked balances
     * @param endIndex end index in the caller's list of locked balances (exclusive)
     */
    function claimBalance(uint256 startIndex, uint256 endIndex) external protected {
        // get the locked balances from the store
        (uint256[] memory amounts, uint256[] memory expirationTimes) =
            _store.lockedBalanceRange(msg.sender, startIndex, endIndex);

        uint256 totalAmount = 0;
        uint256 length = amounts.length;
        assert(length == expirationTimes.length);

        // reverse iteration since we're removing from the list
        for (uint256 i = length; i > 0; i--) {
            uint256 index = i - 1;
            if (expirationTimes[index] > time()) {
                continue;
            }

            // remove the locked balance item
            _store.removeLockedBalance(msg.sender, startIndex + index);
            totalAmount = totalAmount.add(amounts[index]);
        }

        if (totalAmount > 0) {
            // transfer the tokens to the caller in a single call
            _wallet.withdrawTokens(_networkToken, msg.sender, totalAmount);
        }
    }

    /**
     * @dev returns the ROI for removing liquidity in the current state after providing liquidity with the given args
     * the function assumes full protection is in effect
     * return value is in PPM and can be larger than PPM_RESOLUTION for positive ROI, 1M = 0% ROI
     *
     * @param poolToken pool token
     * @param reserveToken reserve token
     * @param reserveAmount reserve token amount that was added
     * @param poolRateN rate of 1 pool token in reserve token units when the liquidity was added (numerator)
     * @param poolRateD rate of 1 pool token in reserve token units when the liquidity was added (denominator)
     * @param reserveRateN rate of 1 reserve token in the other reserve token units when the liquidity was added (numerator)
     * @param reserveRateD rate of 1 reserve token in the other reserve token units when the liquidity was added (denominator)
     *
     * @return ROI in PPM
     */
    function poolROI(
        IDSToken poolToken,
        IERC20 reserveToken,
        uint256 reserveAmount,
        uint256 poolRateN,
        uint256 poolRateD,
        uint256 reserveRateN,
        uint256 reserveRateD
    ) external view returns (uint256) {
        // calculate the amount of pool tokens based on the amount of reserve tokens
        uint256 poolAmount = reserveAmount.mul(poolRateD).div(poolRateN);

        // get the various rates between the reserves upon adding liquidity and now
        PackedRates memory packedRates = packRates(poolToken, reserveToken, reserveRateN, reserveRateD, false);

        // get the current return
        uint256 protectedReturn =
            removeLiquidityTargetAmount(
                poolToken,
                reserveToken,
                poolAmount,
                reserveAmount,
                packedRates,
                time().sub(_settings.maxProtectionDelay()),
                time()
            );

        // calculate the ROI as the ratio between the current fully protected return and the initial amount
        return protectedReturn.mul(PPM_RESOLUTION).div(reserveAmount);
    }

    /**
     * @dev adds protected liquidity for the caller to the store
     *
     * @param provider protected liquidity provider
     * @param poolToken pool token
     * @param reserveToken reserve token
     * @param poolAmount amount of pool tokens to protect
     * @param reserveAmount amount of reserve tokens to protect
     *
     * @return new protected liquidity id
     */
    function addProtectedLiquidity(
        address provider,
        IDSToken poolToken,
        IERC20 reserveToken,
        uint256 poolAmount,
        uint256 reserveAmount
    ) internal returns (uint256) {
        // notify event subscribers
        address[] memory subscribers = _settings.subscribers();
        uint256 length = subscribers.length;
        for (uint256 i = 0; i < length; i++) {
            ILiquidityProtectionEventsSubscriber(subscribers[i]).onAddingLiquidity(
                provider,
                poolToken,
                reserveToken,
                poolAmount,
                reserveAmount
            );
        }

        (uint256 rateN, uint256 rateD, , ) = reserveTokenRates(poolToken, reserveToken, true);

        _stats.increaseTotalAmounts(provider, poolToken, reserveToken, poolAmount, reserveAmount);
        _stats.addProviderPool(provider, poolToken);
        return
            _store.addProtectedLiquidity(
                provider,
                poolToken,
                reserveToken,
                poolAmount,
                reserveAmount,
                rateN,
                rateD,
                time()
            );
    }

    /**
     * @dev locks network tokens for the provider and emits the tokens locked event
     *
     * @param provider tokens provider
     * @param amount amount of network tokens
     */
    function lockTokens(address provider, uint256 amount) internal {
        uint256 expirationTime = time().add(_settings.lockDuration());
        _store.addLockedBalance(provider, amount, expirationTime);
    }

    /**
     * @dev returns the rate of 1 pool token in reserve token units
     *
     * @param poolToken pool token
     * @param reserveToken reserve token
     */
    function poolTokenRate(IDSToken poolToken, IERC20 reserveToken) internal view virtual returns (Fraction memory) {
        // get the pool token supply
        uint256 poolTokenSupply = poolToken.totalSupply();

        // get the reserve balance
        IConverter converter = IConverter(payable(ownedBy(poolToken)));
        uint256 reserveBalance = converter.getConnectorBalance(reserveToken);

        // for standard pools, 50% of the pool supply value equals the value of each reserve
        return Fraction({ n: reserveBalance.mul(2), d: poolTokenSupply });
    }

    /**
     * @dev returns the spot rate and average rate of 1 reserve token in the other reserve token units
     *
     * @param poolToken pool token
     * @param reserveToken reserve token
     * @param validateAverageRate true to validate the average rate; false otherwise
     */
    function reserveTokenRates(
        IDSToken poolToken,
        IERC20 reserveToken,
        bool validateAverageRate
    )
        internal
        view
        returns (
            uint256,
            uint256,
            uint256,
            uint256
        )
    {
        ILiquidityPoolConverter converter = ILiquidityPoolConverter(payable(ownedBy(poolToken)));
        IERC20 otherReserve = converterOtherReserve(converter, reserveToken);

        (uint256 spotRateN, uint256 spotRateD) = converterReserveBalances(converter, otherReserve, reserveToken);
        (uint256 averageRateN, uint256 averageRateD) = converter.recentAverageRate(reserveToken);

        require(
            !validateAverageRate ||
                averageRateInRange(
                    spotRateN,
                    spotRateD,
                    averageRateN,
                    averageRateD,
                    _settings.averageRateMaxDeviation()
                ),
            "ERR_INVALID_RATE"
        );

        return (spotRateN, spotRateD, averageRateN, averageRateD);
    }

    /**
     * @dev returns the various rates between the reserves
     *
     * @param poolToken pool token
     * @param reserveToken reserve token
     * @param addSpotRateN add spot rate numerator
     * @param addSpotRateD add spot rate denominator
     * @param validateAverageRate true to validate the average rate; false otherwise
     * @return see `struct PackedRates`
     */
    function packRates(
        IDSToken poolToken,
        IERC20 reserveToken,
        uint256 addSpotRateN,
        uint256 addSpotRateD,
        bool validateAverageRate
    ) internal view returns (PackedRates memory) {
        (uint256 removeSpotRateN, uint256 removeSpotRateD, uint256 removeAverageRateN, uint256 removeAverageRateD) =
            reserveTokenRates(poolToken, reserveToken, validateAverageRate);

        assert(
            (addSpotRateN <= MAX_UINT128 && addSpotRateD <= MAX_UINT128) &&
                (removeSpotRateN <= MAX_UINT128 && removeSpotRateD <= MAX_UINT128) &&
                (removeAverageRateN <= MAX_UINT128 && removeAverageRateD <= MAX_UINT128)
        );

        return
            PackedRates({
                addSpotRateN: uint128(addSpotRateN),
                addSpotRateD: uint128(addSpotRateD),
                removeSpotRateN: uint128(removeSpotRateN),
                removeSpotRateD: uint128(removeSpotRateD),
                removeAverageRateN: uint128(removeAverageRateN),
                removeAverageRateD: uint128(removeAverageRateD)
            });
    }

    /**
     * @dev returns whether or not the deviation of the average rate from the spot rate is within range
     * for example, if the maximum permitted deviation is 5%, then return `95/100 <= average/spot <= 100/95`
     *
     * @param spotRateN spot rate numerator
     * @param spotRateD spot rate denominator
     * @param averageRateN average rate numerator
     * @param averageRateD average rate denominator
     * @param maxDeviation the maximum permitted deviation of the average rate from the spot rate
     */
    function averageRateInRange(
        uint256 spotRateN,
        uint256 spotRateD,
        uint256 averageRateN,
        uint256 averageRateD,
        uint32 maxDeviation
    ) internal pure returns (bool) {
        uint256 ppmDelta = PPM_RESOLUTION - maxDeviation;
        uint256 min = spotRateN.mul(averageRateD).mul(ppmDelta).mul(ppmDelta);
        uint256 mid = spotRateD.mul(averageRateN).mul(ppmDelta).mul(PPM_RESOLUTION);
        uint256 max = spotRateN.mul(averageRateD).mul(PPM_RESOLUTION).mul(PPM_RESOLUTION);
        return min <= mid && mid <= max;
    }

    /**
     * @dev utility to add liquidity to a converter
     *
     * @param converter converter
     * @param reserveToken1 reserve token 1
     * @param reserveToken2 reserve token 2
     * @param reserveAmount1 reserve amount 1
     * @param reserveAmount2 reserve amount 2
     * @param value ETH amount to add
     */
    function addLiquidity(
        ILiquidityPoolConverter converter,
        IERC20 reserveToken1,
        IERC20 reserveToken2,
        uint256 reserveAmount1,
        uint256 reserveAmount2,
        uint256 value
    ) internal {
        IERC20[] memory reserveTokens = new IERC20[](2);
        uint256[] memory amounts = new uint256[](2);
        reserveTokens[0] = reserveToken1;
        reserveTokens[1] = reserveToken2;
        amounts[0] = reserveAmount1;
        amounts[1] = reserveAmount2;
        converter.addLiquidity{ value: value }(reserveTokens, amounts, 1);
    }

    /**
     * @dev utility to remove liquidity from a converter
     *
     * @param poolToken pool token of the converter
     * @param poolAmount amount of pool tokens to remove
     * @param reserveToken1 reserve token 1
     * @param reserveToken2 reserve token 2
     */
    function removeLiquidity(
        IDSToken poolToken,
        uint256 poolAmount,
        IERC20 reserveToken1,
        IERC20 reserveToken2
    ) internal {
        ILiquidityPoolConverter converter = ILiquidityPoolConverter(payable(ownedBy(poolToken)));

        IERC20[] memory reserveTokens = new IERC20[](2);
        uint256[] memory minReturns = new uint256[](2);
        reserveTokens[0] = reserveToken1;
        reserveTokens[1] = reserveToken2;
        minReturns[0] = 1;
        minReturns[1] = 1;
        converter.removeLiquidity(poolAmount, reserveTokens, minReturns);
    }

    /**
     * @dev returns a protected liquidity from the store
     *
     * @param id protected liquidity id
     *
     * @return protected liquidity
     */
    function protectedLiquidity(uint256 id) internal view returns (ProtectedLiquidity memory) {
        ProtectedLiquidity memory liquidity;
        (
            liquidity.provider,
            liquidity.poolToken,
            liquidity.reserveToken,
            liquidity.poolAmount,
            liquidity.reserveAmount,
            liquidity.reserveRateN,
            liquidity.reserveRateD,
            liquidity.timestamp
        ) = _store.protectedLiquidity(id);

        return liquidity;
    }

    /**
     * @dev returns a protected liquidity from the store
     *
     * @param id protected liquidity id
     * @param provider authorized provider
     *
     * @return protected liquidity
     */
    function protectedLiquidity(uint256 id, address provider) internal view returns (ProtectedLiquidity memory) {
        ProtectedLiquidity memory liquidity = protectedLiquidity(id);
        require(liquidity.provider == provider, "ERR_ACCESS_DENIED");

        return liquidity;
    }

    /**
     * @dev returns the protected amount of reserve tokens plus accumulated fee before compensation
     *
     * @param poolAmount pool token amount when the liquidity was added
     * @param poolRate rate of 1 pool token in the related reserve token units
     * @param addRate rate of 1 reserve token in the other reserve token units when the liquidity was added
     * @param removeRate rate of 1 reserve token in the other reserve token units when the liquidity is removed
     *
     * @return protected amount of reserve tokens plus accumulated fee = sqrt(removeRate / addRate) * poolRate * poolAmount
     */
    function protectedAmountPlusFee(
        uint256 poolAmount,
        Fraction memory poolRate,
        Fraction memory addRate,
        Fraction memory removeRate
    ) internal pure returns (uint256) {
        uint256 n = MathEx.ceilSqrt(addRate.d.mul(removeRate.n)).mul(poolRate.n);
        uint256 d = MathEx.floorSqrt(addRate.n.mul(removeRate.d)).mul(poolRate.d);

        uint256 x = n * poolAmount;
        if (x / n == poolAmount) {
            return x / d;
        }

        (uint256 hi, uint256 lo) = n > poolAmount ? (n, poolAmount) : (poolAmount, n);
        (uint256 p, uint256 q) = MathEx.reducedRatio(hi, d, MAX_UINT256 / lo);
        uint256 min = (hi / d).mul(lo);

        if (q > 0) {
            return MathEx.max(min, (p * lo) / q);
        }
        return min;
    }

    /**
     * @dev returns the impermanent loss incurred due to the change in rates between the reserve tokens
     *
     * @param prevRate previous rate between the reserves
     * @param newRate new rate between the reserves
     * @return impermanent loss (as a ratio)
     */
    function impLoss(Fraction memory prevRate, Fraction memory newRate) internal pure returns (Fraction memory) {
        uint256 ratioN = newRate.n.mul(prevRate.d);
        uint256 ratioD = newRate.d.mul(prevRate.n);

        uint256 prod = ratioN * ratioD;
        uint256 root =
            prod / ratioN == ratioD ? MathEx.floorSqrt(prod) : MathEx.floorSqrt(ratioN) * MathEx.floorSqrt(ratioD);
        uint256 sum = ratioN.add(ratioD);

        // the arithmetic below is safe because `x + y >= sqrt(x * y) * 2`
        if (sum % 2 == 0) {
            sum /= 2;
            return Fraction({ n: sum - root, d: sum });
        }
        return Fraction({ n: sum - root * 2, d: sum });
    }

    /**
     * @dev returns the protection level based on the timestamp and protection delays
     *
     * @param addTimestamp time at which the liquidity was added
     * @param removeTimestamp time at which the liquidity is removed
     *
     * @return protection level (as a ratio)
     */
    function protectionLevel(uint256 addTimestamp, uint256 removeTimestamp) internal view returns (Fraction memory) {
        uint256 timeElapsed = removeTimestamp.sub(addTimestamp);
        uint256 minProtectionDelay = _settings.minProtectionDelay();
        uint256 maxProtectionDelay = _settings.maxProtectionDelay();
        if (timeElapsed < minProtectionDelay) {
            return Fraction({ n: 0, d: 1 });
        }

        if (timeElapsed >= maxProtectionDelay) {
            return Fraction({ n: 1, d: 1 });
        }

        return Fraction({ n: timeElapsed, d: maxProtectionDelay });
    }

    /**
     * @dev returns the compensation amount based on the impermanent loss and the protection level
     *
     * @param amount protected amount in units of the reserve token
     * @param total amount plus fee in units of the reserve token
     * @param loss protection level (as a ratio between 0 and 1)
     * @param level impermanent loss (as a ratio between 0 and 1)
     *
     * @return compensation amount
     */
    function compensationAmount(
        uint256 amount,
        uint256 total,
        Fraction memory loss,
        Fraction memory level
    ) internal pure returns (uint256) {
        uint256 levelN = level.n.mul(amount);
        uint256 levelD = level.d;
        uint256 maxVal = MathEx.max(MathEx.max(levelN, levelD), total);
        (uint256 lossN, uint256 lossD) = MathEx.reducedRatio(loss.n, loss.d, MAX_UINT256 / maxVal);
        return total.mul(lossD.sub(lossN)).div(lossD).add(lossN.mul(levelN).div(lossD.mul(levelD)));
    }

    function networkCompensation(
        uint256 targetAmount,
        uint256 baseAmount,
        PackedRates memory packedRates
    ) internal view returns (uint256) {
        if (targetAmount <= baseAmount) {
            return 0;
        }

        // calculate the delta in network tokens
        uint256 delta =
            (targetAmount - baseAmount).mul(packedRates.removeAverageRateN).div(packedRates.removeAverageRateD);

        // the delta might be very small due to precision loss
        // in which case no compensation will take place (gas optimization)
        if (delta >= _settings.minNetworkCompensation()) {
            return delta;
        }

        return 0;
    }

    /**
     * @dev utility, checks whether allowance for the given spender exists and approves one if it doesn't.
     * note that we use the non standard erc-20 interface in which `approve` has no return value so that
     * this function will work for both standard and non standard tokens
     *
     * @param token token to check the allowance in
     * @param spender approved address
     * @param value allowance amount
     */
    function ensureAllowance(
        IERC20 token,
        address spender,
        uint256 value
    ) private {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < value) {
            if (allowance > 0) {
                token.safeApprove(spender, 0);
            }
            token.safeApprove(spender, value);
        }
    }

    // utility to mint network tokens
    function mintNetworkTokens(
        address owner,
        IConverterAnchor poolAnchor,
        uint256 amount
    ) private {
        _networkTokenGovernance.mint(owner, amount);
        _systemStore.incNetworkTokensMinted(poolAnchor, amount);
    }

    // utility to burn network tokens
    function burnNetworkTokens(IConverterAnchor poolAnchor, uint256 amount) private {
        _networkTokenGovernance.burn(amount);
        _systemStore.decNetworkTokensMinted(poolAnchor, amount);
    }

    // utility to notify event subscribers on removing liquidity
    function notifyEventSubscribersOnRemovingLiquidity(
        uint256 id,
        address provider,
        IDSToken poolToken,
        IERC20 reserveToken,
        uint256 poolAmount,
        uint256 reserveAmount
    ) private {
        address[] memory subscribers = _settings.subscribers();
        uint256 length = subscribers.length;
        for (uint256 i = 0; i < length; i++) {
            ILiquidityProtectionEventsSubscriber(subscribers[i]).onRemovingLiquidity(
                id,
                provider,
                poolToken,
                reserveToken,
                poolAmount,
                reserveAmount
            );
        }
    }

    // utility to get the reserve balances
    function converterReserveBalances(
        IConverter converter,
        IERC20 reserveToken1,
        IERC20 reserveToken2
    ) private view returns (uint256, uint256) {
        return (converter.getConnectorBalance(reserveToken1), converter.getConnectorBalance(reserveToken2));
    }

    // utility to get the other reserve
    function converterOtherReserve(IConverter converter, IERC20 thisReserve) private view returns (IERC20) {
        IERC20 otherReserve = converter.connectorTokens(0);
        return otherReserve != thisReserve ? otherReserve : converter.connectorTokens(1);
    }

    // utility to get the owner
    function ownedBy(IOwned owned) private view returns (address) {
        return owned.owner();
    }
}
