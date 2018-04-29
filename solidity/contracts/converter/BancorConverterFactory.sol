pragma solidity ^0.4.21;
import './BancorConverter.sol';
import './interfaces/IBancorConverterFactory.sol';
import '../utility/interfaces/IContractFeatures.sol';

/*
    Bancor Converter Factory
*/
contract BancorConverterFactory is IBancorConverterFactory {

    // triggered when a new converter is created
    event NewConverter(address indexed _converter, address indexed _owner);

    /**
        @dev constructor
    */
    function BancorConverterFactory()
        public
    {}

    /**
        @dev creates a new converter with the given arguments and transfers
        the ownership and management to the sender.

        @param  _token              smart token governed by the converter
        @param  _features           address of a contract features contract
        @param  _extensions         address of a bancor converter extensions contract
        @param  _maxConversionFee   maximum conversion fee, represented in ppm
        @param  _connectorToken     optional, initial connector, allows defining the first connector at deployment time
        @param  _connectorWeight    optional, weight for the initial connector

        @return a new converter
    */
    function createConverter(
        ISmartToken _token,
        IContractFeatures _features,
        IBancorConverterExtensions _extensions,
        uint32 _maxConversionFee,
        IERC20Token _connectorToken,
        uint32 _connectorWeight
    ) 
        public 
        returns(address converterAddress) 
    {
        BancorConverter converter = new BancorConverter(
            _token,
            _features,
            _extensions,
            _maxConversionFee,
            _connectorToken,
            _connectorWeight
        );

        converter.transferOwnership(msg.sender);
        converter.transferManagement(msg.sender);

        address _converterAddress = address(converter);
        emit NewConverter(_converterAddress, msg.sender);
        return _converterAddress;
    }
}
