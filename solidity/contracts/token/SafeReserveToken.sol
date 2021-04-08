// SPDX-License-Identifier: SEE LICENSE IN LICENSE
pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";

import "./interfaces/IReserveToken.sol";

import "./SafeERC20Token.sol";

/**
 * @dev This library implements ERC20 and SafeERC20 utilities for reserve tokens, which can be either ERC20 tokens or
 * ETH reserves.
 */
library SafeReserveToken {
    using SafeERC20Token for IERC20;

    // the address that represents an ETH reserve
    IReserveToken public constant NATIVE_TOKEN_ADDRESS = IReserveToken(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE);

    /**
     * @dev returns whether the provided token represents an ERC20 token or ETH reserve
     *
     * @param reserveToken the address of the reserve token
     *
     * @return whether the provided token represents an ERC20 token or ETH reserve
     */
    function isNativeToken(IReserveToken reserveToken) internal pure returns (bool) {
        return reserveToken == NATIVE_TOKEN_ADDRESS;
    }

    /**
     * @dev returns the balance of the reserve token
     *
     * @param reserveToken the address of the reserve token
     * @param account the address of the account to check
     *
     * @return the balance of the reserve token
     */
    function balanceOf(IReserveToken reserveToken, address account) internal view returns (uint256) {
        if (isNativeToken(reserveToken)) {
            return account.balance;
        }

        return toIERC20(reserveToken).balanceOf(account);
    }

    /**
     * @dev transfers a specific amount of the reserve token
     *
     * @param reserveToken the address of the reserve token
     * @param to the destination address to transfer the amount to
     * @param amount the amount to transfer
     */
    function safeTransfer(
        IReserveToken reserveToken,
        address to,
        uint256 amount
    ) internal {
        if (amount == 0) {
            return;
        }

        if (isNativeToken(reserveToken)) {
            payable(to).transfer(amount);
        } else {
            toIERC20(reserveToken).safeTransfer(to, amount);
        }
    }

    /**
     * @dev transfers the whole balance of the reserve token
     *
     * @param reserveToken the address of the reserve token
     * @param to the destination address to transfer the amount to
     */
    function safeTransfer(IReserveToken reserveToken, address to) internal {
        safeTransfer(reserveToken, to, balanceOf(reserveToken, address(this)));
    }

    /**
     * @dev transfers a specific amount of the reserve token
     * this function ignores a reserve token which represents an ETH reserve
     *
     * @param reserveToken the address of the reserve token
     * @param from the source address to transfer the amount from
     * @param to the destination address to transfer the amount to
     * @param amount the amount to transfer
     */
    function safeTransferFrom(
        IReserveToken reserveToken,
        address from,
        address to,
        uint256 amount
    ) internal {
        if (amount == 0 || isNativeToken(reserveToken)) {
            return;
        }

        toIERC20(reserveToken).safeTransferFrom(from, to, amount);
    }

    /**
     * @dev ensures that the spender has sufficient allowance
     * this function ignores a reserve token which represents an ETH reserve
     *
     * @param reserveToken the address of the reserve token
     * @param spender the address allowed to spend
     * @param amount the allowed amount to spend
     */
    function ensureAllowance(
        IReserveToken reserveToken,
        address spender,
        uint256 amount
    ) internal {
        if (isNativeToken(reserveToken)) {
            return;
        }

        IERC20(address(reserveToken)).ensureAllowance(spender, amount);
    }

    /**
     * @dev utility function that converts an IReserveToken to an IERC20
     *
     * @param reserveToken the address of the reserve token
     *
     * @return an IERC20
     */
    function toIERC20(IReserveToken reserveToken) private pure returns (IERC20) {
        return IERC20(address(reserveToken));
    }
}
