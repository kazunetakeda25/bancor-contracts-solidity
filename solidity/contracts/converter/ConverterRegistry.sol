// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

import "../utility/ContractRegistryClient.sol";

import "../token/interfaces/IDSToken.sol";

import "./interfaces/IConverter.sol";
import "./interfaces/IConverterFactory.sol";
import "./interfaces/IConverterRegistry.sol";
import "./interfaces/IConverterRegistryData.sol";

/**
 * @dev This contract maintains a list of all active converters in the Bancor Network.
 *
 * Since converters can be upgraded and thus their address can change, the registry actually keeps
 * converter anchors internally and not the converters themselves.
 * The active converter for each anchor can be easily accessed by querying the anchor's owner.
 *
 * The registry exposes 3 different lists that can be accessed and iterated, based on the use-case of the caller:
 * - Anchors - can be used to get all the latest / historical data in the network
 * - Liquidity pools - can be used to get all liquidity pools for funding, liquidation etc.
 * - Convertible tokens - can be used to get all tokens that can be converted in the network (excluding pool
 *   tokens), and for each one - all anchors that hold it in their reserves
 *
 *
 * The contract fires events whenever one of the primitives is added to or removed from the registry
 *
 * The contract is upgradable.
 */
contract ConverterRegistry is IConverterRegistry, ContractRegistryClient {
    /**
     * @dev triggered when a converter anchor is added to the registry
     *
     * @param anchor anchor token
     */
    event ConverterAnchorAdded(IConverterAnchor indexed anchor);

    /**
     * @dev triggered when a converter anchor is removed from the registry
     *
     * @param anchor anchor token
     */
    event ConverterAnchorRemoved(IConverterAnchor indexed anchor);

    /**
     * @dev triggered when a liquidity pool is added to the registry
     *
     * @param liquidityPool liquidity pool
     */
    event LiquidityPoolAdded(IConverterAnchor indexed liquidityPool);

    /**
     * @dev triggered when a liquidity pool is removed from the registry
     *
     * @param liquidityPool liquidity pool
     */
    event LiquidityPoolRemoved(IConverterAnchor indexed liquidityPool);

    /**
     * @dev triggered when a convertible token is added to the registry
     *
     * @param convertibleToken convertible token
     * @param smartToken associated anchor token
     */
    event ConvertibleTokenAdded(IReserveToken indexed convertibleToken, IConverterAnchor indexed smartToken);

    /**
     * @dev triggered when a convertible token is removed from the registry
     *
     * @param convertibleToken convertible token
     * @param smartToken associated anchor token
     */
    event ConvertibleTokenRemoved(IReserveToken indexed convertibleToken, IConverterAnchor indexed smartToken);

    /**
     * @dev deprecated, backward compatibility, use `ConverterAnchorAdded`
     */
    event SmartTokenAdded(IConverterAnchor indexed smartToken);

    /**
     * @dev deprecated, backward compatibility, use `ConverterAnchorRemoved`
     */
    event SmartTokenRemoved(IConverterAnchor indexed smartToken);

    /**
     * @dev initializes a new ConverterRegistry instance
     *
     * @param registry address of a contract registry contract
     */
    constructor(IContractRegistry registry) public ContractRegistryClient(registry) {}

    /**
     * @dev creates an empty liquidity pool and adds its converter to the registry
     *
     * @param converterType converter type
     * @param name token / pool name
     * @param symbol token / pool symbol
     * @param decimals token / pool decimals
     * @param maxConversionFee maximum conversion-fee
     * @param reserveTokens reserve tokens
     * @param reserveWeights reserve weights
     *
     * @return new converter
     */
    function newConverter(
        uint16 converterType,
        string memory name,
        string memory symbol,
        uint8 decimals,
        uint32 maxConversionFee,
        IReserveToken[] memory reserveTokens,
        uint32[] memory reserveWeights
    ) public virtual returns (IConverter) {
        uint256 length = reserveTokens.length;
        require(length == reserveWeights.length, "ERR_INVALID_RESERVES");

        // for standard pools, change type 1 to type 3
        if (converterType == 1 && isStandardPool(reserveWeights)) {
            converterType = 3;
        }

        require(
            getLiquidityPoolByConfig(converterType, reserveTokens, reserveWeights) == IConverterAnchor(0),
            "ERR_ALREADY_EXISTS"
        );

        IConverterFactory factory = IConverterFactory(addressOf(CONVERTER_FACTORY));
        IConverterAnchor anchor = IConverterAnchor(factory.createAnchor(converterType, name, symbol, decimals));
        IConverter converter = IConverter(factory.createConverter(converterType, anchor, registry, maxConversionFee));

        anchor.acceptOwnership();
        converter.acceptOwnership();

        for (uint256 i = 0; i < length; i++) {
            converter.addReserve(reserveTokens[i], reserveWeights[i]);
        }

        anchor.transferOwnership(address(converter));
        converter.acceptAnchorOwnership();
        converter.transferOwnership(msg.sender);

        addConverterInternal(converter);

        return converter;
    }

    /**
     * @dev adds an existing converter to the registry
     * can only be called by the owner
     *
     * @param converter converter
     */
    function addConverter(IConverter converter) public ownerOnly {
        require(isConverterValid(converter), "ERR_INVALID_CONVERTER");

        addConverterInternal(converter);
    }

    /**
     * @dev removes a converter from the registry
     * anyone can remove an existing converter from the registry, as long as the converter is invalid
     * note that the owner can also remove valid converters
     *
     * @param converter converter
     */
    function removeConverter(IConverter converter) public {
        require(msg.sender == owner || !isConverterValid(converter), "ERR_ACCESS_DENIED");

        removeConverterInternal(converter);
    }

    /**
     * @dev returns the number of converter anchors in the registry
     *
     * @return number of anchors
     */
    function getAnchorCount() public view override returns (uint256) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getSmartTokenCount();
    }

    /**
     * @dev returns the list of converter anchors in the registry
     *
     * @return list of anchors
     */
    function getAnchors() public view override returns (address[] memory) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getSmartTokens();
    }

    /**
     * @dev returns the converter anchor at a given index
     *
     * @param index index
     *
     * @return anchor at the given index
     */
    function getAnchor(uint256 index) public view override returns (IConverterAnchor) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getSmartToken(index);
    }

    /**
     * @dev checks whether or not a given value is a converter anchor
     *
     * @param value value
     *
     * @return true if the given value is an anchor, false if not
     */
    function isAnchor(address value) public view override returns (bool) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).isSmartToken(value);
    }

    /**
     * @dev returns the number of liquidity pools in the registry
     *
     * @return number of liquidity pools
     */
    function getLiquidityPoolCount() public view override returns (uint256) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getLiquidityPoolCount();
    }

    /**
     * @dev returns the list of liquidity pools in the registry
     *
     * @return list of liquidity pools
     */
    function getLiquidityPools() public view override returns (address[] memory) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getLiquidityPools();
    }

    /**
     * @dev returns the liquidity pool at a given index
     *
     * @param index index
     *
     * @return liquidity pool at the given index
     */
    function getLiquidityPool(uint256 index) public view override returns (IConverterAnchor) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getLiquidityPool(index);
    }

    /**
     * @dev checks whether or not a given value is a liquidity pool
     *
     * @param value value
     *
     * @return true if the given value is a liquidity pool, false if not
     */
    function isLiquidityPool(address value) public view override returns (bool) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).isLiquidityPool(value);
    }

    /**
     * @dev returns the number of convertible tokens in the registry
     *
     * @return number of convertible tokens
     */
    function getConvertibleTokenCount() public view override returns (uint256) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleTokenCount();
    }

    /**
     * @dev returns the list of convertible tokens in the registry
     *
     * @return list of convertible tokens
     */
    function getConvertibleTokens() public view override returns (address[] memory) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleTokens();
    }

    /**
     * @dev returns the convertible token at a given index
     *
     * @param index index
     *
     * @return convertible token at the given index
     */
    function getConvertibleToken(uint256 index) public view override returns (IReserveToken) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleToken(index);
    }

    /**
     * @dev checks whether or not a given value is a convertible token
     *
     * @param value value
     *
     * @return true if the given value is a convertible token, false if not
     */
    function isConvertibleToken(address value) public view override returns (bool) {
        return IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).isConvertibleToken(value);
    }

    /**
     * @dev returns the number of converter anchors associated with a given convertible token
     *
     * @param convertibleToken convertible token
     *
     * @return number of anchors associated with the given convertible token
     */
    function getConvertibleTokenAnchorCount(IReserveToken convertibleToken) public view override returns (uint256) {
        return
            IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleTokenSmartTokenCount(
                convertibleToken
            );
    }

    /**
     * @dev returns the list of converter anchors associated with a given convertible token
     *
     * @param convertibleToken convertible token
     *
     * @return list of anchors associated with the given convertible token
     */
    function getConvertibleTokenAnchors(IReserveToken convertibleToken)
        public
        view
        override
        returns (address[] memory)
    {
        return
            IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleTokenSmartTokens(convertibleToken);
    }

    /**
     * @dev returns the converter anchor associated with a given convertible token at a given index
     *
     * @param index index
     *
     * @return anchor associated with the given convertible token at the given index
     */
    function getConvertibleTokenAnchor(IReserveToken convertibleToken, uint256 index)
        public
        view
        override
        returns (IConverterAnchor)
    {
        return
            IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).getConvertibleTokenSmartToken(
                convertibleToken,
                index
            );
    }

    /**
     * @dev checks whether or not a given value is a converter anchor of a given convertible token
     *
     * @param convertibleToken convertible token
     * @param value value
     *
     * @return true if the given value is an anchor of the given convertible token, false if not
     */
    function isConvertibleTokenAnchor(IReserveToken convertibleToken, address value)
        public
        view
        override
        returns (bool)
    {
        return
            IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA)).isConvertibleTokenSmartToken(
                convertibleToken,
                value
            );
    }

    /**
     * @dev returns a list of converters for a given list of anchors
     * this is a utility function that can be used to reduce the number of calls to the contract
     *
     * @param anchors list of converter anchors
     *
     * @return list of converters
     */
    function getConvertersByAnchors(address[] memory anchors) public view returns (IConverter[] memory) {
        IConverter[] memory converters = new IConverter[](anchors.length);

        for (uint256 i = 0; i < anchors.length; i++) {
            converters[i] = IConverter(payable(IConverterAnchor(anchors[i]).owner()));
        }

        return converters;
    }

    /**
     * @dev checks whether or not a given converter is valid
     *
     * @param converter converter
     *
     * @return true if the given converter is valid, false if not
     */
    function isConverterValid(IConverter converter) public view returns (bool) {
        // verify that the converter is active
        return converter.token().owner() == address(converter);
    }

    /**
     * @dev checks if a liquidity pool with given configuration is already registered
     *
     * @param converter converter with specific configuration
     *
     * @return if a liquidity pool with the same configuration is already registered
     */
    function isSimilarLiquidityPoolRegistered(IConverter converter) public view returns (bool) {
        uint256 reserveTokenCount = converter.connectorTokenCount();
        IReserveToken[] memory reserveTokens = new IReserveToken[](reserveTokenCount);
        uint32[] memory reserveWeights = new uint32[](reserveTokenCount);

        // get the reserve-configuration of the converter
        for (uint256 i = 0; i < reserveTokenCount; i++) {
            IReserveToken reserveToken = converter.connectorTokens(i);
            reserveTokens[i] = reserveToken;
            reserveWeights[i] = getReserveWeight(converter, reserveToken);
        }

        // return if a liquidity pool with the same configuration is already registered
        return
            getLiquidityPoolByConfig(getConverterType(converter, reserveTokenCount), reserveTokens, reserveWeights) !=
            IConverterAnchor(0);
    }

    /**
     * @dev searches for a liquidity pool with specific configuration
     *
     * @param converterType converter type
     * @param reserveTokens reserve tokens
     * @param reserveWeights reserve weights
     *
     * @return the liquidity pool, or zero if no such liquidity pool exists
     */
    function getLiquidityPoolByConfig(
        uint16 converterType,
        IReserveToken[] memory reserveTokens,
        uint32[] memory reserveWeights
    ) public view override returns (IConverterAnchor) {
        // verify that the input parameters represent a valid liquidity pool
        if (reserveTokens.length == reserveWeights.length && reserveTokens.length > 1) {
            // get the anchors of the least frequent token (optimization)
            address[] memory convertibleTokenAnchors = getLeastFrequentTokenAnchors(reserveTokens);
            // search for a converter with the same configuration
            for (uint256 i = 0; i < convertibleTokenAnchors.length; i++) {
                IConverterAnchor anchor = IConverterAnchor(convertibleTokenAnchors[i]);
                IConverter converter = IConverter(payable(anchor.owner()));
                if (isConverterReserveConfigEqual(converter, converterType, reserveTokens, reserveWeights)) {
                    return anchor;
                }
            }
        }

        return IConverterAnchor(0);
    }

    /**
     * @dev adds a converter anchor to the registry
     *
     * @param anchor converter anchor
     */
    function addAnchor(IConverterRegistryData converterRegistryData, IConverterAnchor anchor) internal {
        converterRegistryData.addSmartToken(anchor);
        emit ConverterAnchorAdded(anchor);
        emit SmartTokenAdded(anchor);
    }

    /**
     * @dev removes a converter anchor from the registry
     *
     * @param anchor converter anchor
     */
    function removeAnchor(IConverterRegistryData converterRegistryData, IConverterAnchor anchor) internal {
        converterRegistryData.removeSmartToken(anchor);
        emit ConverterAnchorRemoved(anchor);
        emit SmartTokenRemoved(anchor);
    }

    /**
     * @dev adds a liquidity pool to the registry
     *
     * @param liquidityPoolAnchor liquidity pool converter anchor
     */
    function addLiquidityPool(IConverterRegistryData converterRegistryData, IConverterAnchor liquidityPoolAnchor)
        internal
    {
        converterRegistryData.addLiquidityPool(liquidityPoolAnchor);
        emit LiquidityPoolAdded(liquidityPoolAnchor);
    }

    /**
     * @dev removes a liquidity pool from the registry
     *
     * @param liquidityPoolAnchor liquidity pool converter anchor
     */
    function removeLiquidityPool(IConverterRegistryData converterRegistryData, IConverterAnchor liquidityPoolAnchor)
        internal
    {
        converterRegistryData.removeLiquidityPool(liquidityPoolAnchor);
        emit LiquidityPoolRemoved(liquidityPoolAnchor);
    }

    /**
     * @dev adds a convertible token to the registry
     *
     * @param convertibleToken convertible token
     * @param anchor associated converter anchor
     */
    function addConvertibleToken(
        IConverterRegistryData converterRegistryData,
        IReserveToken convertibleToken,
        IConverterAnchor anchor
    ) internal {
        converterRegistryData.addConvertibleToken(convertibleToken, anchor);
        emit ConvertibleTokenAdded(convertibleToken, anchor);
    }

    /**
     * @dev removes a convertible token from the registry
     *
     * @param convertibleToken convertible token
     * @param anchor associated converter anchor
     */
    function removeConvertibleToken(
        IConverterRegistryData converterRegistryData,
        IReserveToken convertibleToken,
        IConverterAnchor anchor
    ) internal {
        converterRegistryData.removeConvertibleToken(convertibleToken, anchor);

        emit ConvertibleTokenRemoved(convertibleToken, anchor);
    }

    /**
     * @dev checks whether or not a given configuration depicts a standard pool
     *
     * @param reserveWeights reserve weights
     *
     * @return true if the given configuration depicts a standard pool, false otherwise
     */
    function isStandardPool(uint32[] memory reserveWeights) internal pure virtual returns (bool) {
        return
            reserveWeights.length == 2 &&
            reserveWeights[0] == PPM_RESOLUTION / 2 &&
            reserveWeights[1] == PPM_RESOLUTION / 2;
    }

    function addConverterInternal(IConverter converter) private {
        IConverterRegistryData converterRegistryData = IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA));
        IConverterAnchor anchor = IConverter(converter).token();
        uint256 reserveTokenCount = converter.connectorTokenCount();

        // add the converter anchor
        addAnchor(converterRegistryData, anchor);
        if (reserveTokenCount > 1) {
            addLiquidityPool(converterRegistryData, anchor);
        } else {
            addConvertibleToken(converterRegistryData, IReserveToken(address(anchor)), anchor);
        }

        // add all reserve tokens
        for (uint256 i = 0; i < reserveTokenCount; i++) {
            addConvertibleToken(converterRegistryData, converter.connectorTokens(i), anchor);
        }
    }

    function removeConverterInternal(IConverter converter) private {
        IConverterRegistryData converterRegistryData = IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA));
        IConverterAnchor anchor = IConverter(converter).token();
        uint256 reserveTokenCount = converter.connectorTokenCount();

        // remove the converter anchor
        removeAnchor(converterRegistryData, anchor);
        if (reserveTokenCount > 1) {
            removeLiquidityPool(converterRegistryData, anchor);
        } else {
            removeConvertibleToken(converterRegistryData, IReserveToken(address(anchor)), anchor);
        }

        // remove all reserve tokens
        for (uint256 i = 0; i < reserveTokenCount; i++) {
            removeConvertibleToken(converterRegistryData, converter.connectorTokens(i), anchor);
        }
    }

    function getLeastFrequentTokenAnchors(IReserveToken[] memory reserveTokens)
        private
        view
        returns (address[] memory)
    {
        IConverterRegistryData converterRegistryData = IConverterRegistryData(addressOf(CONVERTER_REGISTRY_DATA));
        uint256 minAnchorCount = converterRegistryData.getConvertibleTokenSmartTokenCount(reserveTokens[0]);
        uint256 index = 0;

        // find the reserve token which has the smallest number of converter anchors
        for (uint256 i = 1; i < reserveTokens.length; i++) {
            uint256 convertibleTokenAnchorCount =
                converterRegistryData.getConvertibleTokenSmartTokenCount(reserveTokens[i]);
            if (minAnchorCount > convertibleTokenAnchorCount) {
                minAnchorCount = convertibleTokenAnchorCount;
                index = i;
            }
        }

        return converterRegistryData.getConvertibleTokenSmartTokens(reserveTokens[index]);
    }

    function isConverterReserveConfigEqual(
        IConverter converter,
        uint16 converterType,
        IReserveToken[] memory reserveTokens,
        uint32[] memory reserveWeights
    ) private view returns (bool) {
        uint256 reserveTokenCount = converter.connectorTokenCount();

        if (converterType != getConverterType(converter, reserveTokenCount)) {
            return false;
        }

        if (reserveTokens.length != reserveTokenCount) {
            return false;
        }

        for (uint256 i = 0; i < reserveTokens.length; i++) {
            if (reserveWeights[i] != getReserveWeight(converter, reserveTokens[i])) {
                return false;
            }
        }

        return true;
    }

    // utility to get the reserve weight (including from older converters that don't support the new getReserveWeight function)
    function getReserveWeight(IConverter converter, IReserveToken reserveToken) private view returns (uint32) {
        (, uint32 weight, , , ) = converter.connectors(reserveToken);
        return weight;
    }

    bytes4 private constant CONVERTER_TYPE_FUNC_SELECTOR = bytes4(keccak256("converterType()"));

    // utility to get the converter type (including from older converters that don't support the new converterType function)
    function getConverterType(IConverter converter, uint256 reserveTokenCount) private view returns (uint16) {
        (bool success, bytes memory returnData) =
            address(converter).staticcall(abi.encodeWithSelector(CONVERTER_TYPE_FUNC_SELECTOR));
        if (success && returnData.length == 32) {
            return abi.decode(returnData, (uint16));
        }

        return reserveTokenCount > 1 ? 1 : 0;
    }

    /**
     * @dev deprecated, backward compatibility, use `getAnchorCount`
     */
    function getSmartTokenCount() public view returns (uint256) {
        return getAnchorCount();
    }

    /**
     * @dev deprecated, backward compatibility, use `getAnchors`
     */
    function getSmartTokens() public view returns (address[] memory) {
        return getAnchors();
    }

    /**
     * @dev deprecated, backward compatibility, use `getAnchor`
     */
    function getSmartToken(uint256 index) public view returns (IConverterAnchor) {
        return getAnchor(index);
    }

    /**
     * @dev deprecated, backward compatibility, use `isAnchor`
     */
    function isSmartToken(address value) public view returns (bool) {
        return isAnchor(value);
    }

    /**
     * @dev deprecated, backward compatibility, use `getConvertibleTokenAnchorCount`
     */
    function getConvertibleTokenSmartTokenCount(IReserveToken convertibleToken) public view returns (uint256) {
        return getConvertibleTokenAnchorCount(convertibleToken);
    }

    /**
     * @dev deprecated, backward compatibility, use `getConvertibleTokenAnchors`
     */
    function getConvertibleTokenSmartTokens(IReserveToken convertibleToken) public view returns (address[] memory) {
        return getConvertibleTokenAnchors(convertibleToken);
    }

    /**
     * @dev deprecated, backward compatibility, use `getConvertibleTokenAnchor`
     */
    function getConvertibleTokenSmartToken(IReserveToken convertibleToken, uint256 index)
        public
        view
        returns (IConverterAnchor)
    {
        return getConvertibleTokenAnchor(convertibleToken, index);
    }

    /**
     * @dev deprecated, backward compatibility, use `isConvertibleTokenAnchor`
     */
    function isConvertibleTokenSmartToken(IReserveToken convertibleToken, address value) public view returns (bool) {
        return isConvertibleTokenAnchor(convertibleToken, value);
    }

    /**
     * @dev deprecated, backward compatibility, use `getConvertersByAnchors`
     */
    function getConvertersBySmartTokens(address[] memory smartTokens) public view returns (IConverter[] memory) {
        return getConvertersByAnchors(smartTokens);
    }

    /**
     * @dev deprecated, backward compatibility, use `getLiquidityPoolByConfig`
     */
    function getLiquidityPoolByReserveConfig(IReserveToken[] memory reserveTokens, uint32[] memory reserveWeights)
        public
        view
        returns (IConverterAnchor)
    {
        return getLiquidityPoolByConfig(reserveTokens.length > 1 ? 1 : 0, reserveTokens, reserveWeights);
    }
}
