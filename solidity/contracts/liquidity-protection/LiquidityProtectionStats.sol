// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";

import "./interfaces/ILiquidityProtectionStats.sol";
import "../utility/Utils.sol";
import "../utility/SafeMath.sol";
import "../token/interfaces/IDSToken.sol";
import "../token/interfaces/IERC20Token.sol";

/**
 * @dev This contract aggregates the statistics of the liquidity protection mechanism.
 */
contract LiquidityProtectionStats is ILiquidityProtectionStats, AccessControl, Utils {
    using SafeMath for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;

    bytes32 public constant ROLE_SUPERVISOR = keccak256("ROLE_SUPERVISOR");
    bytes32 public constant ROLE_SEEDER = keccak256("ROLE_SEEDER");
    bytes32 public constant ROLE_OWNER = keccak256("ROLE_OWNER");

    mapping(IDSToken => uint256) private _totalPoolAmount;
    mapping(IDSToken => mapping(IERC20Token => uint256)) private _totalReserveAmount;
    mapping(IDSToken => mapping(IERC20Token => mapping(address => uint256))) private _totalProviderAmount;

    mapping(address => EnumerableSet.AddressSet) private _providerPools;

    // allows execution by the owner only
    modifier ownerOnly {
        require(hasRole(ROLE_OWNER, msg.sender), "ERR_ACCESS_DENIED");
        _;
    }

    // allows execution by the seeder only
    modifier seederOnly {
        require(hasRole(ROLE_SEEDER, msg.sender), "ERR_ACCESS_DENIED");
        _;
    }

    constructor() public {
        // set up administrative roles
        _setRoleAdmin(ROLE_SUPERVISOR, ROLE_SUPERVISOR);
        _setRoleAdmin(ROLE_SEEDER, ROLE_SUPERVISOR);
        _setRoleAdmin(ROLE_OWNER, ROLE_SUPERVISOR);

        // allow the deployer to initially govern the contract
        _setupRole(ROLE_SUPERVISOR, msg.sender);
    }

    /**
     * @dev increases the total amounts
     *
     * @param _provider         liquidity provider address
     * @param _poolToken        pool token address
     * @param _reserveToken     reserve token address
     * @param _poolAmount       pool token amount
     * @param _reserveAmount    reserve token amount
     */
    function increaseTotalAmounts(
        address _provider,
        IDSToken _poolToken,
        IERC20Token _reserveToken,
        uint256 _poolAmount,
        uint256 _reserveAmount
    ) external override ownerOnly {
        _totalPoolAmount[_poolToken] = _totalPoolAmount[_poolToken].add(_poolAmount);
        _totalReserveAmount[_poolToken][_reserveToken] = _totalReserveAmount[_poolToken][_reserveToken].add(_reserveAmount);
        _totalProviderAmount[_poolToken][_reserveToken][_provider] = _totalProviderAmount[_poolToken][_reserveToken][_provider].add(_reserveAmount);
    }

    /**
     * @dev decreases the total amounts
     *
     * @param _provider         liquidity provider address
     * @param _poolToken        pool token address
     * @param _reserveToken     reserve token address
     * @param _poolAmount       pool token amount
     * @param _reserveAmount    reserve token amount
     */
    function decreaseTotalAmounts(
        address _provider,
        IDSToken _poolToken,
        IERC20Token _reserveToken,
        uint256 _poolAmount,
        uint256 _reserveAmount
    ) external override ownerOnly {
        _totalPoolAmount[_poolToken] = _totalPoolAmount[_poolToken].sub(_poolAmount);
        _totalReserveAmount[_poolToken][_reserveToken] = _totalReserveAmount[_poolToken][_reserveToken].sub(_reserveAmount);
        _totalProviderAmount[_poolToken][_reserveToken][_provider] = _totalProviderAmount[_poolToken][_reserveToken][_provider].sub(_reserveAmount);
    }

    /**
     * @dev adds a pool to the list of pools of a liquidity provider
     *
     * @param _provider         liquidity provider address
     * @param _poolToken        pool token address
     */
    function addProviderPool(
        address _provider,
        IDSToken _poolToken
    ) external override ownerOnly returns (bool) {
        return _providerPools[_provider].add(address(_poolToken));
    }

    /**
     * @dev removes a pool from the list of pools of a liquidity provider
     *
     * @param _provider         liquidity provider address
     * @param _poolToken        pool token address
     */
    function removeProviderPool(
        address _provider,
        IDSToken _poolToken
    ) external override ownerOnly returns (bool) {
        return _providerPools[_provider].remove(address(_poolToken));
    }

    /**
     * @dev returns the total amount of protected pool tokens
     *
     * @param _poolToken    pool token address
     * @return total amount of protected pool tokens
     */
    function totalPoolAmount(
        IDSToken _poolToken
    ) external view override returns (uint256) {
        return _totalPoolAmount[_poolToken];
    }

    /**
     * @dev returns the total amount of protected reserve tokens
     *
     * @param _poolToken    pool token address
     * @param _reserveToken reserve token address
     * @return total amount of protected reserve tokens
     */
    function totalReserveAmount(
        IDSToken _poolToken,
        IERC20Token _reserveToken
    ) external view override returns (uint256) {
        return _totalReserveAmount[_poolToken][_reserveToken];
    }

    /**
     * @dev returns the total amount of a liquidity provider's protected reserve tokens
     *
     * @param _poolToken    pool token address
     * @param _reserveToken reserve token address
     * @param _provider     liquidity provider address
     * @return total amount of the liquidity provider's protected reserve tokens
     */
    function totalProviderAmount(
        IDSToken _poolToken,
        IERC20Token _reserveToken,
        address _provider
    ) external view override returns (uint256) {
        return _totalProviderAmount[_poolToken][_reserveToken][_provider];
    }

    /**
     * @dev returns the list of pools of a liquidity provider
     *
     * @param _provider liquidity provider address
     * @return pool tokens
     */
    function providerPools(
        address _provider
    ) external view override returns (IDSToken[] memory) {
        EnumerableSet.AddressSet storage set = _providerPools[_provider];
        uint256 length = set.length();
        IDSToken[] memory arr = new IDSToken[](length);
        for (uint256 i = 0; i < length; i++) {
            arr[i] = IDSToken(set.at(i));
        }
        return arr;
    }

    function seedPoolAmounts(
        IDSToken[] calldata _tokens,
        uint256[] calldata _amounts
    ) external seederOnly {
        uint256 length = _tokens.length;
        for (uint256 i = 0; i < length; i++) {
            _totalPoolAmount[_tokens[i]] = _amounts[i];
        }
    }

    function seedReserveAmounts(
        IDSToken[] calldata _tokens,
        IERC20Token[] calldata _reserves,
        uint256[] calldata _amounts
    ) external seederOnly {
        uint256 length = _tokens.length;
        for (uint256 i = 0; i < length; i++) {
            _totalReserveAmount[_tokens[i]][_reserves[i]] = _amounts[i];
        }
    }

    function seedProviderAmounts(
        IDSToken[] calldata _tokens,
        IERC20Token[] calldata _reserves,
        address[] calldata _providers,
        uint256[] calldata _amounts
    ) external seederOnly {
        uint256 length = _tokens.length;
        for (uint256 i = 0; i < length; i++) {
            _totalProviderAmount[_tokens[i]][_reserves[i]][_providers[i]] = _amounts[i];
            _providerPools[_providers[i]].add(address(_tokens[i]));
        }
    }
}
