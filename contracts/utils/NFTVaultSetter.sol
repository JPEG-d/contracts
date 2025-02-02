// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.4;

import "@openzeppelin/contracts/access/Ownable.sol";

import "../interfaces/INFTVault.sol";

contract NFTVaultSetter is Ownable {
    /// @notice Allows the DAO to change the total debt cap
    /// @param _borrowAmountCap New total debt cap
    function setBorrowAmountCap(
        INFTVault _vault,
        uint256 _borrowAmountCap
    ) external onlyOwner {
        INFTVault.VaultSettings memory settings = _vault.settings();
        settings.borrowAmountCap = _borrowAmountCap;
        _vault.setSettings(settings);
    }

    /// @notice Allows the DAO to change the interest APR on borrows
    /// @param _debtInterestApr The new interest rate
    function setDebtInterestApr(
        INFTVault _vault,
        INFTVault.Rate calldata _debtInterestApr
    ) external onlyOwner {
        _vault.accrue();
        INFTVault.VaultSettings memory settings = _vault.settings();
        settings.debtInterestApr = _debtInterestApr;
        _vault.setSettings(settings);
    }

    /// @notice Allows the DAO to change the amount of time insurance remains valid after liquidation
    /// @param _newLimit New time limit
    function setInsuranceRepurchaseTimeLimit(
        INFTVault _vault,
        uint256 _newLimit
    ) external onlyOwner {
        require(_newLimit != 0, "invalid_limit");
        INFTVault.VaultSettings memory settings = _vault.settings();
        settings.insuranceRepurchaseTimeLimit = _newLimit;
        _vault.setSettings(settings);
    }

    /// @notice Allows the DAO to change the static borrow fee
    /// @param _organizationFeeRate The new fee rate
    function setOrganizationFeeRate(
        INFTVault _vault,
        INFTVault.Rate calldata _organizationFeeRate
    ) external onlyOwner {
        _validateRateBelowOne(_organizationFeeRate);
        INFTVault.VaultSettings memory settings = _vault.settings();
        settings.organizationFeeRate = _organizationFeeRate;
        _vault.setSettings(settings);
    }

    /// @notice Allows the DAO to change the cost of insurance
    /// @param _insurancePurchaseRate The new insurance fee rate
    function setInsurancePurchaseRate(
        INFTVault _vault,
        INFTVault.Rate calldata _insurancePurchaseRate
    ) external onlyOwner {
        _validateRateBelowOne(_insurancePurchaseRate);
        INFTVault.VaultSettings memory settings = _vault.settings();
        settings.insurancePurchaseRate = _insurancePurchaseRate;
        _vault.setSettings(settings);
    }

    /// @notice Allows the DAO to change the repurchase penalty rate in case of liquidation of an insured NFT
    /// @param _insuranceLiquidationPenaltyRate The new rate
    function setInsuranceLiquidationPenaltyRate(
        INFTVault _vault,
        INFTVault.Rate calldata _insuranceLiquidationPenaltyRate
    ) external onlyOwner {
        _validateRateBelowOne(_insuranceLiquidationPenaltyRate);
        INFTVault.VaultSettings memory settings = _vault.settings();
        settings
            .insuranceLiquidationPenaltyRate = _insuranceLiquidationPenaltyRate;
        _vault.setSettings(settings);
    }

    /// @dev Checks if `r1` is greater than `r2`.
    function _greaterThan(
        INFTVault.Rate memory _r1,
        INFTVault.Rate memory _r2
    ) internal pure returns (bool) {
        return
            _r1.numerator * _r2.denominator > _r2.numerator * _r1.denominator;
    }

    /// @dev Validates a rate. The denominator must be greater than zero and greater than or equal to the numerator.
    /// @param rate The rate to validate
    function _validateRateBelowOne(INFTVault.Rate memory rate) internal pure {
        require(
            rate.denominator != 0 && rate.denominator >= rate.numerator,
            "invalid_rate"
        );
    }
}
