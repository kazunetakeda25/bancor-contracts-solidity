pragma solidity ^0.4.24;

/**
    Id definitions for bancor contracts

    Can be used in conjunction with the contract registry to get contract addresses
*/
contract ContractIds {
    // generic
    bytes32 public constant CONTRACT_FEATURES = "ContractFeatures";
    bytes32 public constant CONTRACT_REGISTRY = "ContractRegistry";

    // bancor logic
    bytes32 public constant BANCOR_NETWORK = "BancorNetwork";
    bytes32 public constant BANCOR_FORMULA = "BancorFormula";
    bytes32 public constant BANCOR_GAS_PRICE_LIMIT = "BancorGasPriceLimit";
    bytes32 public constant BANCOR_CONVERTER_UPGRADER = "BancorConverterUpgrader";
    bytes32 public constant BANCOR_CONVERTER_FACTORY = "BancorConverterFactory";

    // for BancorX
    bytes32 public constant BNT_CONVERTER = "BntConverter";
    bytes32 public constant BNT_TOKEN = "BntToken";

    // for BNT converter
    bytes32 public constant BANCOR_X = "BancorX";
}
