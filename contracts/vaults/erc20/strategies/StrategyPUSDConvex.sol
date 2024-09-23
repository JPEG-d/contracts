// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.4;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../../../utils/RateLib.sol";

import "../../../interfaces/ICurve.sol";
import "../../../interfaces/I3CRVZap.sol";
import "../../../interfaces/IBooster.sol";
import "../../../interfaces/IBaseRewardPool.sol";
import "../../../interfaces/ISwapRouter.sol";

import "../../../interfaces/IStrategy.sol";

/// @title JPEG'd PUSD Convex autocompounding strategy
/// @notice This strategy autocompounds Convex rewards from the PUSD/USDC/USDT/DAI Curve pool.
/// @dev The strategy deposits either USDC or PUSD in the Curve pool depending on which one has lower liquidity.
/// The strategy sells reward tokens for USDC. If the pool has less PUSD than USDC, this contract uses the
/// USDC {FungibleAssetVaultForDAO} to mint PUSD using USDC as collateral
contract StrategyPUSDConvex is AccessControl, IStrategy {
    using SafeERC20 for IERC20;
    using SafeERC20 for ICurve;
    using RateLib for RateLib.Rate;

    error ZeroAddress();

    event Harvested(uint256 wantEarned);

    bytes32 public constant STRATEGIST_ROLE = keccak256("STRATEGIST_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    ICurve public immutable WANT;

    IERC20 public immutable WETH;
    IERC20 public immutable USDC;

    IERC20 public immutable CVX;
    IERC20 public immutable CRV;

    ICurve public immutable CVX_ETH;
    ICurve public immutable CRV_ETH;

    I3CRVZap public immutable CRV_ZAP;

    IBooster public immutable CVX_BOOSTER;
    IBaseRewardPool public immutable REWARD_POOL;
    uint256 public immutable CVX_PUSD_PID;

    ISwapRouter public immutable V3_ROUTER;

    address public feeRecipient;

    /// @notice The performance fee to be sent to the DAO/strategists
    RateLib.Rate public performanceFee;

    /// @notice lifetime strategy earnings denominated in `want` token
    uint256 public earned;

    struct ConstructorParams {
        address want;
        address weth;
        address usdc;
        address cvx;
        address crv;
        address cvxETH;
        address crvETH;
        address crvZap;
        address booster;
        address rewardPool;
        uint256 pid;
        address v3Router;
        address feeAddress;
        RateLib.Rate performanceFee;
    }

    constructor(ConstructorParams memory _params) {
        if (
            _params.want == address(0) ||
            _params.weth == address(0) ||
            _params.usdc == address(0) ||
            _params.cvx == address(0) ||
            _params.crv == address(0) ||
            _params.cvxETH == address(0) ||
            _params.crvETH == address(0) ||
            _params.crvZap == address(0) ||
            _params.booster == address(0) ||
            _params.rewardPool == address(0) ||
            _params.v3Router == address(0) ||
            _params.feeAddress == address(0)
        ) revert ZeroAddress();

        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        setFeeRecipient(_params.feeAddress);
        setPerformanceFee(_params.performanceFee);

        WANT = ICurve(_params.want);

        WETH = IERC20(_params.weth);
        USDC = IERC20(_params.usdc);

        CVX = IERC20(_params.cvx);
        CRV = IERC20(_params.crv);

        CVX_ETH = ICurve(_params.cvxETH);
        CRV_ETH = ICurve(_params.crvETH);

        CRV_ZAP = I3CRVZap(_params.crvZap);

        CVX_BOOSTER = IBooster(_params.booster);
        REWARD_POOL = IBaseRewardPool(_params.rewardPool);
        CVX_PUSD_PID = _params.pid;

        V3_ROUTER = ISwapRouter(_params.v3Router);

        IERC20(_params.want).safeApprove(_params.booster, type(uint256).max);
        IERC20(_params.cvx).safeApprove(_params.cvxETH, type(uint256).max);
        IERC20(_params.crv).safeApprove(_params.crvETH, type(uint256).max);
        IERC20(_params.usdc).safeApprove(_params.crvZap, type(uint256).max);
    }

    receive() external payable {}

    /// @notice Has to be called once after deploying the contract
    /// This code cannot be put in the constructor as it triggers stack too deep
    /// at compile time
    function setupApprovals() external onlyRole(DEFAULT_ADMIN_ROLE) {
        WANT.safeApprove(address(CVX_BOOSTER), type(uint256).max);
        CVX.safeApprove(address(CVX_ETH), type(uint256).max);
        CRV.safeApprove(address(CRV_ETH), type(uint256).max);
        USDC.safeApprove(address(CRV_ZAP), type(uint256).max);
    }

    /// @notice Allows the DAO to set the performance fee
    /// @param _performanceFee The new performance fee
    function setPerformanceFee(
        RateLib.Rate memory _performanceFee
    ) public onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_performanceFee.isValid() || !_performanceFee.isBelowOne())
            revert RateLib.InvalidRate();

        performanceFee = _performanceFee;
    }

    function setFeeRecipient(
        address _newRecipient
    ) public onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_newRecipient == address(0)) revert ZeroAddress();

        feeRecipient = _newRecipient;
    }

    /// @return The amount of `want` tokens held by this contract
    function heldAssets() public view returns (uint256) {
        return WANT.balanceOf(address(this));
    }

    /// @return The amount of `want` tokens deposited in the Convex pool by this contract
    function depositedAssets() public view returns (uint256) {
        return REWARD_POOL.balanceOf(address(this));
    }

    /// @return The total amount of `want` tokens this contract manages (held + deposited)
    function totalAssets() external view override returns (uint256) {
        return heldAssets() + depositedAssets();
    }

    /// @notice Allows anyone to deposit the total amount of `want` tokens in this contract into Convex
    function deposit() public override {
        CVX_BOOSTER.depositAll(CVX_PUSD_PID, true);
    }

    /// @notice Controller only function that allows to withdraw non-strategy tokens (e.g tokens sent accidentally).
    /// CVX and CRV can be withdrawn with this function.
    function withdraw(
        address _to,
        address _asset
    ) external override onlyRole(STRATEGIST_ROLE) {
        if (_to == address(0)) revert ZeroAddress();

        if (_asset == address(WANT)) revert();

        uint256 _balance = IERC20(_asset).balanceOf(address(this));
        IERC20(_asset).safeTransfer(_to, _balance);
    }

    /// @notice Allows the controller to withdraw `want` tokens. Normally used with a vault withdrawal
    /// @param _to The address to send the tokens to
    /// @param _amount The amount of `want` tokens to withdraw
    function withdraw(
        address _to,
        uint256 _amount
    ) external override onlyRole(VAULT_ROLE) {
        uint256 _balance = WANT.balanceOf(address(this));
        //if the contract doesn't have enough want, withdraw from Convex
        if (_balance < _amount) {
            unchecked {
                REWARD_POOL.withdrawAndUnwrap(_amount - _balance, false);
            }
        }

        WANT.safeTransfer(_to, _amount);
    }

    /// @notice Allows the controller to withdraw all `want` tokens. Normally used when migrating strategies
    function withdrawAll() external override onlyRole(VAULT_ROLE) {
        REWARD_POOL.withdrawAllAndUnwrap(true);

        uint256 _balance = WANT.balanceOf(address(this));
        WANT.safeTransfer(msg.sender, _balance);
    }

    /// @notice Allows members of the `STRATEGIST_ROLE` to compound Convex rewards into Curve
    /// @param minOutCurve The minimum amount of `want` tokens to receive
    function harvest(uint256 minOutCurve) external onlyRole(STRATEGIST_ROLE) {
        REWARD_POOL.getReward(address(this), true);

        //Prevent `Stack too deep` errors
        {
            uint256 _cvxBalance = CVX.balanceOf(address(this));
            if (_cvxBalance > 0)
                //minOut is not needed here, we already have it on the Curve deposit
                CVX_ETH.exchange(1, 0, _cvxBalance, 0, true);

            uint256 _crvBalance = CRV.balanceOf(address(this));
            if (_crvBalance > 0)
                //minOut is not needed here, we already have it on the Curve deposit
                CRV_ETH.exchange(2, 1, _crvBalance, 0, true);

            uint256 _ethBalance = address(this).balance;
            if (_ethBalance == 0) revert();

            //minOut is not needed here, we already have it on the Curve deposit
            ISwapRouter.ExactInputParams memory params = ISwapRouter
                .ExactInputParams(
                    abi.encodePacked(WETH, uint24(500), USDC),
                    address(this),
                    block.timestamp,
                    _ethBalance,
                    0
                );

            V3_ROUTER.exactInput{ value: _ethBalance }(params);
        }

        uint256 _usdcBalance = USDC.balanceOf(address(this));

        //take the performance fee
        uint256 _fee = (_usdcBalance * performanceFee.numerator) /
            performanceFee.denominator;
        USDC.safeTransfer(feeRecipient, _fee);
        unchecked {
            _usdcBalance -= _fee;
        }

        CRV_ZAP.add_liquidity(
            address(WANT),
            [0, 0, _usdcBalance, 0],
            minOutCurve
        );

        uint256 _wantBalance = heldAssets();

        deposit();

        earned += _wantBalance;
        emit Harvested(_wantBalance);
    }
}
