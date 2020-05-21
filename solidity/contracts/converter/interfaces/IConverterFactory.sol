pragma solidity 0.4.26;
import './IConverter.sol';
import '../../token/interfaces/ISmartToken.sol';
import '../../utility/interfaces/IContractRegistry.sol';

/*
    Converter Factory interface
*/
contract IConverterFactory {
    function createConverter(
        uint8 _type,
        ISmartToken _token,
        IContractRegistry _registry,
        uint32 _maxConversionFee
    )
    public returns (IConverter);
}
