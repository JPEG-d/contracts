import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
    FungibleAssetVaultForDAO,
    IBaseRewardPool,
    StableCoin,
    StrategyPUSDConvex,
    Vault,
    MockBooster,
    TestERC20,
    MockCurvePool,
    MockSwapRouter,
    Mock3CRVZap
} from "../types";
import { units, ZERO_ADDRESS } from "./utils";

describe("StrategyPUSDConvex", () => {
    let owner: SignerWithAddress, user: SignerWithAddress;
    let strategy: StrategyPUSDConvex;
    let vault: Vault;
    let booster: MockBooster;
    let uniswapV3Router: MockSwapRouter;
    let pusd: StableCoin;
    let rewardPool: IBaseRewardPool;
    let zap: Mock3CRVZap;

    let cvx: TestERC20,
        crv: TestERC20,
        weth: TestERC20,
        usdc: TestERC20,
        crv3: TestERC20;

    let cvxETH: MockCurvePool, crvETH: MockCurvePool, want: MockCurvePool;

    beforeEach(async () => {
        const accounts = await ethers.getSigners();
        owner = accounts[0];
        user = accounts[1];

        const TestERC20 = await ethers.getContractFactory("TestERC20");

        weth = await TestERC20.deploy("", "");
        cvx = await TestERC20.deploy("", "");
        crv = await TestERC20.deploy("", "");
        usdc = await TestERC20.deploy("", "");
        crv3 = await TestERC20.deploy("", "");

        const Stablecoin = await ethers.getContractFactory("StableCoin");
        pusd = await Stablecoin.deploy();

        const CurvePool = await ethers.getContractFactory("MockCurvePool");
        cvxETH = await CurvePool.deploy("", "");
        crvETH = await CurvePool.deploy("", "");
        want = await CurvePool.deploy("", "");

        const Zap = await ethers.getContractFactory("Mock3CRVZap");
        zap = await Zap.deploy(crv3.address);

        await cvxETH.setTokenIndex(0, weth.address);
        await cvxETH.setTokenIndex(1, cvx.address);
        await crvETH.setTokenIndex(1, weth.address);
        await crvETH.setTokenIndex(2, crv.address);
        await want.setTokenIndex(0, pusd.address);
        await want.setTokenIndex(1, crv3.address);
        await zap.setTokenIndex(2, usdc.address);
        await zap.setTokenIndex(0, pusd.address);

        await usdc.setDecimals(6);

        const Vault = await ethers.getContractFactory("Vault");
        vault = <Vault>(
            await upgrades.deployProxy(Vault, [
                want.address,
                owner.address,
                { numerator: 0, denominator: 100 }
            ])
        );

        const RewardPool = await ethers.getContractFactory("MockRewardPool");
        rewardPool = await RewardPool.deploy(want.address, crv.address, []);

        const Booster = await ethers.getContractFactory("MockBooster");
        booster = await Booster.deploy(rewardPool.address);

        await booster.setPidToken(0, want.address);

        const Router = await ethers.getContractFactory("MockSwapRouter");
        uniswapV3Router = await Router.deploy();

        const Strategy = await ethers.getContractFactory(
            "StrategyPUSDConvex",
            owner
        );
        strategy = await Strategy.deploy({
            want: want.address,
            weth: weth.address,
            usdc: usdc.address,
            cvx: cvx.address,
            crv: crv.address,
            cvxETH: cvxETH.address,
            crvETH: crvETH.address,
            crvZap: zap.address,
            booster: booster.address,
            rewardPool: rewardPool.address,
            pid: 0,
            v3Router: uniswapV3Router.address,
            feeAddress: owner.address,
            performanceFee: { numerator: 20, denominator: 100 }
        });

        await strategy.grantRole(
            ethers.utils.solidityKeccak256(["string"], ["STRATEGIST_ROLE"]),
            owner.address
        );
        await strategy.grantRole(
            ethers.utils.solidityKeccak256(["string"], ["VAULT_ROLE"]),
            vault.address
        );

        const minter = ethers.utils.solidityKeccak256(
            ["string"],
            ["MINTER_ROLE"]
        );
        await crv3.grantRole(minter, zap.address);
        await pusd.grantRole(minter, owner.address);

        await vault.migrateStrategy(strategy.address);
        await vault.unpause();
    });

    it("should allow strategists to withdraw non strategy tokens", async () => {
        await expect(
            strategy["withdraw(address,address)"](owner.address, want.address)
        ).to.be.reverted;

        await cvx.mint(strategy.address, units(500));
        await strategy["withdraw(address,address)"](owner.address, cvx.address);

        expect(await cvx.balanceOf(owner.address)).to.equal(units(500));
    });

    it("should allow the vault to withdraw want", async () => {
        await want.mint(user.address, units(100));
        await want.connect(user).approve(vault.address, units(100));

        await vault.connect(user).deposit(user.address, units(100));
        expect(await strategy.depositedAssets()).to.equal(units(100));

        await want.mint(strategy.address, units(100));

        await vault.connect(user).withdraw(user.address, units(50));
        expect(await want.balanceOf(user.address)).to.equal(units(100));

        await vault.connect(user).withdraw(user.address, units(50));
        expect(await want.balanceOf(user.address)).to.equal(units(200));
    });

    it("should allow the vault to call withdrawAll", async () => {
        await want.mint(owner.address, units(500));
        await want.approve(vault.address, units(500));
        await vault.deposit(owner.address, units(500));

        await expect(strategy.withdrawAll()).to.be.reverted;

        await vault.migrateStrategy(ZERO_ADDRESS);

        expect(await want.balanceOf(vault.address)).to.equal(units(500));
    });

    it("should add liquidity with usdc when harvest is called", async () => {
        await expect(strategy.harvest(0)).to.be.reverted;

        await crv3.mint(want.address, units(500_000));
        await pusd.mint(want.address, units(500_000));

        await want.mint(owner.address, units(1_000_000));
        await want.approve(vault.address, units(1_000_000));
        await vault.deposit(owner.address, units(1_000_000));

        expect(await strategy.depositedAssets()).to.equal(units(1_000_000));

        await crv.mint(rewardPool.address, units(1_000_000));

        await owner.sendTransaction({ to: crvETH.address, value: units(2) });
        await usdc.mint(uniswapV3Router.address, 3_000e6);

        await crvETH.setNextAmountOut(units(2));
        await uniswapV3Router.setNextAmountOut(3_000e6);
        await want.setNextMintAmount(units(2400));

        await strategy.harvest(0);

        expect(await usdc.balanceOf(zap.address)).to.equal(2400e6);
        expect(await strategy.depositedAssets()).to.equal(units(1_002_400));
    });
});
