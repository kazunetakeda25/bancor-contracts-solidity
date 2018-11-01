pragma solidity ^0.4.24;

import "../utility/Owned.sol";

contract TxRerouter is Owned {
    bool public reroutingEnabled;

    // triggered when a rerouteTx is called
    event TxReroute(
        uint256 indexed _txId,
        bytes32 _toBlockchain,
        bytes32 _to
    );

    /**
        @dev constructor

        @param _reroutingEnabled    intializes transactions routing to enabled/disabled   
     */
    constructor(bool _reroutingEnabled)
        public
    {
        reroutingEnabled = _reroutingEnabled;
    }
    /**
        @dev allows the owner to disable/enable rerouting

        @param _enable     true to enable, false to disable
     */
    function enableRerouting(bool _enable) public ownerOnly {
        reroutingEnabled = _enable;
    }

    /**
        @dev    allows a user to reroute a transaction to a new blockchain/target address

        @param _txId        the original transaction's ID
        @param _blockchain  the new blockchain name
        @param _to          the new target address/account
     */
    function rerouteTx(
        uint256 _txId,
        bytes32 _blockchain,
        bytes32 _to
    )
        public
    {
        require(reroutingEnabled);
        emit TxReroute(_txId, _blockchain, _to);
    }

}