pragma solidity 0.4.26;

/*
    Converter Upgrader interface
*/
contract IConverterUpgrader {
    function upgrade(bytes32 _version) public;
    function upgrade(uint16 _version) public;
}
