pragma solidity 0.4.26;
import './interfaces/IBancorConverter.sol';
import './interfaces/IBancorConverterRegistryData.sol';
import '../token/interfaces/ISmartToken.sol';
import '../token/interfaces/ISmartTokenController.sol';
import '../utility/ContractRegistryClient.sol';

contract BancorConverterRegistryLogic is ContractRegistryClient {
    /**
      * @dev emitted when a liquidity pool is added
      * 
      * @param _liquidityPool liquidity pool
    */
    event LiquidityPoolAdded(address indexed _liquidityPool);

    /**
      * @dev emitted when a liquidity pool is removed
      * 
      * @param _liquidityPool liquidity pool
    */
    event LiquidityPoolRemoved(address indexed _liquidityPool);

    /**
      * @dev emitted when a convertible token is added
      * 
      * @param _convertibleToken convertible token
      * @param _smartToken associated smart token
    */
    event ConvertibleTokenAdded(address indexed _convertibleToken, address indexed _smartToken);

    /**
      * @dev emitted when a convertible token is removed
      * 
      * @param _convertibleToken convertible token
      * @param _smartToken associated smart token
    */
    event ConvertibleTokenRemoved(address indexed _convertibleToken, address indexed _smartToken);

    /**
      * @dev initialize a new BancorConverterRegistryLogic instance
      * 
      * @param _registry address of a contract registry contract
    */
    constructor(IContractRegistry _registry) ContractRegistryClient(_registry) public {
    }

    /**
      * @dev add a converter
      * 
      * @param _converter converter
    */
    function addConverter(IBancorConverter _converter) external {
        IBancorConverterRegistryData converterRegistryData = IBancorConverterRegistryData(addressOf(BANCOR_CONVERTER_REGISTRY_DATA));
        ISmartToken token = ISmartTokenController(_converter).token();
        require(isValid(token, _converter));
        uint connectorTokenCount = _converter.connectorTokenCount();
        if (connectorTokenCount > 1)
            addLiquidityPool(converterRegistryData, token);
        else
            addConvertibleToken(converterRegistryData, token, token);
        for (uint i = 0; i < connectorTokenCount; i++)
            addConvertibleToken(converterRegistryData, _converter.connectorTokens(i), token);
    }

    /**
      * @dev remove a converter
      * 
      * @param _converter converter
    */
    function removeConverter(IBancorConverter _converter) external {
        IBancorConverterRegistryData converterRegistryData = IBancorConverterRegistryData(addressOf(BANCOR_CONVERTER_REGISTRY_DATA));
        ISmartToken token = ISmartTokenController(_converter).token();
        require(msg.sender == owner || !isValid(token, _converter));
        uint connectorTokenCount = _converter.connectorTokenCount();
        if (connectorTokenCount > 1)
            removeLiquidityPool(converterRegistryData, token);
        else
            removeConvertibleToken(converterRegistryData, token, token);
        for (uint i = 0; i < connectorTokenCount; i++)
            removeConvertibleToken(converterRegistryData, _converter.connectorTokens(i), token);
    }

    function getLiquidityPoolCount() external view returns (uint) {
        return IBancorConverterRegistryData(addressOf(BANCOR_CONVERTER_REGISTRY_DATA)).getLiquidityPoolCount();
    }

    function getLiquidityPoolArray() external view returns (address[]) {
        return IBancorConverterRegistryData(addressOf(BANCOR_CONVERTER_REGISTRY_DATA)).getLiquidityPoolArray();
    }

    function getLiquidityPool(uint _index) external view returns (address) {
        return IBancorConverterRegistryData(addressOf(BANCOR_CONVERTER_REGISTRY_DATA)).getLiquidityPool(_index);
    }

    function getConvertibleTokenCount() external view returns (uint) {
        return IBancorConverterRegistryData(addressOf(BANCOR_CONVERTER_REGISTRY_DATA)).getConvertibleTokenCount();
    }

    function getConvertibleTokenArray() external view returns (address[]) {
        return IBancorConverterRegistryData(addressOf(BANCOR_CONVERTER_REGISTRY_DATA)).getConvertibleTokenArray();
    }

    function getConvertibleToken(uint _index) external view returns (address) {
        return IBancorConverterRegistryData(addressOf(BANCOR_CONVERTER_REGISTRY_DATA)).getConvertibleToken(_index);
    }

    function getSmartTokenCount(address _convertibleToken) external view returns (uint) {
        return IBancorConverterRegistryData(addressOf(BANCOR_CONVERTER_REGISTRY_DATA)).getSmartTokenCount(_convertibleToken);
    }

    function getSmartTokenArray(address _convertibleToken) external view returns (address[]) {
        return IBancorConverterRegistryData(addressOf(BANCOR_CONVERTER_REGISTRY_DATA)).getSmartTokenArray(_convertibleToken);
    }

    function getSmartToken(address _convertibleToken, uint _index) external view returns (address) {
        return IBancorConverterRegistryData(addressOf(BANCOR_CONVERTER_REGISTRY_DATA)).getSmartToken(_convertibleToken, _index);
    }

    /**
      * @dev check whether or not a given token is operative in a given converter
      * 
      * @param _smartToken smart token
      * @param _converter converter
      * @return whether or not the given token is operative in the given converter
    */
    function isValid(ISmartToken _smartToken, IBancorConverter _converter) internal view returns (bool) {
        return _smartToken.totalSupply() > 0 && _smartToken.owner() == address(_converter);
    }

    /**
      * @dev add a liquidity pool
      * 
      * @param _liquidityPool liquidity pool
    */
    function addLiquidityPool(IBancorConverterRegistryData _converterRegistryData, address _liquidityPool) internal {
        _converterRegistryData.addLiquidityPool(_liquidityPool);
        emit LiquidityPoolAdded(_liquidityPool);
    }

    /**
      * @dev remove a liquidity pool
      * 
      * @param _liquidityPool liquidity pool
    */
    function removeLiquidityPool(IBancorConverterRegistryData _converterRegistryData, address _liquidityPool) internal {
        _converterRegistryData.removeLiquidityPool(_liquidityPool);
        emit LiquidityPoolRemoved(_liquidityPool);
    }

    /**
      * @dev add a convertible token
      * 
      * @param _convertibleToken convertible token
      * @param _smartToken associated smart token
    */
    function addConvertibleToken(IBancorConverterRegistryData _converterRegistryData, address _convertibleToken, address _smartToken) internal {
        _converterRegistryData.addConvertibleToken(_convertibleToken, _smartToken);
        emit ConvertibleTokenAdded(_convertibleToken, _smartToken);
    }

    /**
      * @dev remove a convertible token
      * 
      * @param _convertibleToken convertible token
      * @param _smartToken associated smart token
    */
    function removeConvertibleToken(IBancorConverterRegistryData _converterRegistryData, address _convertibleToken, address _smartToken) internal {
        _converterRegistryData.removeConvertibleToken(_convertibleToken, _smartToken);
        emit ConvertibleTokenRemoved(_convertibleToken, _smartToken);
    }
}
