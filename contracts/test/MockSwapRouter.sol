// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/ISwapRouter.sol";

contract MockSwapRouter is ISwapRouter {
    uint256 nextAmountOut;

    function setNextAmountOut(uint256 _next) external {
        nextAmountOut = _next;
    }

    function exactInput(
        ExactInputParams calldata _params
    ) external payable override returns (uint256) {
        require(
            nextAmountOut >= _params.amountOutMinimum,
            "INSUFFICIENT_AMOUNT_OUT"
        );

        bytes memory _path = _params.path;

        IERC20 _inputToken;
        IERC20 _outputToken;

        assembly {
            _inputToken := div(
                mload(add(_path, 0x20)),
                0x1000000000000000000000000
            )
            _outputToken := div(
                mload(add(add(_path, 0x20), 0x17)),
                0x1000000000000000000000000
            )
        }
        if (msg.value != _params.amountIn)
            _inputToken.transferFrom(
                msg.sender,
                address(this),
                _params.amountIn
            );
        _outputToken.transfer(_params.recipient, nextAmountOut);

        return nextAmountOut;
    }
}
