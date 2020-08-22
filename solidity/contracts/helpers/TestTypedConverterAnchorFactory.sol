// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity >=0.6.12 <0.7.0;
import "../converter/interfaces/IConverterAnchor.sol";
import "../converter/interfaces/ITypedConverterAnchorFactory.sol";
import "../token/SmartToken.sol";

contract TestTypedConverterAnchorFactory is ITypedConverterAnchorFactory {
    string public name;

    constructor(string memory _name) public {
        name = _name;
    }

    function converterType() public pure returns (uint16) {
        return 8;
    }

    function createAnchor(string memory /*_name */, string memory _symbol, uint8 _decimals) public returns (IConverterAnchor) {
        IConverterAnchor anchor = new SmartToken(name, _symbol, _decimals);

        anchor.transferOwnership(msg.sender);

        return anchor;
    }
}
