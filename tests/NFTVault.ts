import { BigNumber } from "@ethersproject/bignumber";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
import { solidity } from "ethereum-waffle";
import { AbiCoder } from "ethers/lib/utils";
import { ethers, upgrades } from "hardhat";
import {
  FungibleAssetVaultForDAO,
  JPEG,
  MockV3Aggregator,
  JPEGCardsCigStaking,
  NFTVault,
  StableCoin,
  TestERC20,
  TestERC721,
  UniswapV2MockOracle
} from "../types";
import {
  units,
  bn,
  timeTravel,
  days,
  checkAlmostSame,
  currentTimestamp,
  ZERO_ADDRESS,
} from "./utils";

const { expect } = chai;

chai.use(solidity);

const default_admin_role =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const minter_role =
  "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const dao_role =
  "0x3b5d4cc60d3ec3516ee8ae083bd60934f6eb2a6c54b1229985c41bfb092b2603";
const liquidator_role =
  "0x5e17fc5225d4a099df75359ce1f405503ca79498a8dc46a7d583235a0ee45c16";
const whitelisted_role =
  "0x8429d542926e6695b59ac6fbdcd9b37e8b1aeb757afab06ab60b1bb5878c3b49";
const apeHash =
  "0x26bca2ecad19e981c90a8c6efd8ee9856bbc5a2042259e6ee31e310fdc08d970";
const alienHash =
  "0x3f00f46bb8cf74b3f3e5365e6a583ab26c2d9cffcbff21b7c25fe510854bc81f";
const aliens = [635, 2890, 3100, 3443, 5822, 5905, 6089, 7523, 7804];
const apes = [
  372, 1021, 2140, 2243, 2386, 2460, 2491, 2711, 2924, 4156, 4178, 4464, 5217,
  5314, 5577, 5795, 6145, 6915, 6965, 7191, 8219, 8498, 9265, 9280,
];

describe("NFTVault", () => {
  let owner: SignerWithAddress,
    dao: SignerWithAddress,
    user: SignerWithAddress;
  let nftVault: NFTVault,
    usdcVault: FungibleAssetVaultForDAO,
    jpegOracle: UniswapV2MockOracle,
    ethOracle: MockV3Aggregator,
    usd_oracle: MockV3Aggregator,
    fallbackOracle: MockV3Aggregator,
    cigStaking: JPEGCardsCigStaking,
    usdc: TestERC20,
    stablecoin: StableCoin,
    erc721: TestERC721,
    jpeg: JPEG;

  beforeEach(async () => {
    const accounts = await ethers.getSigners();
    owner = accounts[0];
    dao = accounts[1];
    user = accounts[2];

    const ERC721 = await ethers.getContractFactory("TestERC721");
    erc721 = await ERC721.deploy();
    await erc721.deployed();

    const CigStaking = await ethers.getContractFactory("JPEGCardsCigStaking");
    cigStaking = await CigStaking.deploy(erc721.address, [200]);
    await cigStaking.deployed();

    const TestERC20 = await ethers.getContractFactory("TestERC20");
    usdc = await TestERC20.deploy("Test USDC", "USDC");
    await usdc.deployed();

    const StableCoin = await ethers.getContractFactory("StableCoin");
    stablecoin = await StableCoin.deploy();
    await stablecoin.deployed();

    const MockOracle = await ethers.getContractFactory("UniswapV2MockOracle");
    jpegOracle = await MockOracle.deploy(1000000000000000);
    await jpegOracle.deployed();

    const MockAggregator = await ethers.getContractFactory("MockV3Aggregator");
    ethOracle = await MockAggregator.deploy(8, 3000e8);
    await ethOracle.deployed();

    const floorOracle = await MockAggregator.deploy(18, units(50));
    await floorOracle.deployed();

    fallbackOracle = await MockAggregator.deploy(18, units(10));
    await fallbackOracle.deployed();

    usd_oracle = await MockAggregator.deploy(8, 1e8);
    await usd_oracle.deployed();

    const JPEG = await ethers.getContractFactory("JPEG");

    jpeg = await JPEG.deploy(units(1000000000));
    await jpeg.deployed();

    await jpeg.grantRole(minter_role, owner.address);

    const NFTVault = await ethers.getContractFactory("NFTVault");
    nftVault = <NFTVault>await upgrades.deployProxy(NFTVault, [
      stablecoin.address,
      jpeg.address,
      erc721.address,
      ethOracle.address,
      floorOracle.address,
      [
        [apeHash, { numerator: 10, denominator: 1 }, apes],
        [alienHash, { numerator: 20, denominator: 1 } , aliens],
      ],
      cigStaking.address,
      [
        [2, 100], //debtInterestApr
        [32, 100], //creditLimitRate
        [33, 100], //liquidationLimitRate
        [39, 100], //cigStakedCreditLimitRate
        [40, 100], //cigStakedLiquidationLimitRate
        [25, 100], //valueIncreaseLockRate
        [5, 1000], //organizationFeeRate
        [1, 100], //insuranchePurchaseRate
        [25, 100], //insuranceLiquidationPenaltyRate
        86400 * 3, //insuranceRepurchaseLimit
        units(3000).mul(1000), //borrowAmountCap
      ],
    ]);
    await nftVault.deployed();

    const FungibleAssetVaultForDAO = await ethers.getContractFactory(
      "FungibleAssetVaultForDAO"
    );
    usdcVault = <FungibleAssetVaultForDAO>(
      await upgrades.deployProxy(FungibleAssetVaultForDAO, [
        usdc.address,
        stablecoin.address,
        usd_oracle.address,
        [100, 100],
      ])
    );
    await usdcVault.deployed();

    await stablecoin.grantRole(default_admin_role, dao.address);
    await stablecoin.revokeRole(default_admin_role, owner.address);
    await stablecoin.connect(dao).grantRole(minter_role, nftVault.address);
    await stablecoin.connect(dao).grantRole(minter_role, usdcVault.address);

    await nftVault.grantRole(dao_role, dao.address);
    await nftVault.grantRole(liquidator_role, dao.address);
    await nftVault.revokeRole(dao_role, owner.address);
    await usdcVault.grantRole(default_admin_role, dao.address);
    await usdcVault.grantRole(whitelisted_role, dao.address);
    await usdcVault.revokeRole(default_admin_role, owner.address);
  });

  it("should be able to borrow", async () => {
    await expect(nftVault.borrow(10001, 100, false)).to.be.revertedWith(
      "InvalidNFT(10001)"
    );

    await erc721.mint(user.address, 1);

    await expect(nftVault.borrow(1, 0, false)).to.be.revertedWith(
      "InvalidAmount(0)"
    );

    await expect(nftVault.borrow(1, 100, false)).to.be.revertedWith(
      "ERC721: transfer caller is not owner nor approved"
    );

    const index = 1000;
    const borrowAmount = units(3000).mul(10);
    await erc721.mint(user.address, index);
    await expect(
      nftVault.connect(user).borrow(index, borrowAmount, false)
    ).to.be.revertedWith("ERC721: transfer caller is not owner nor approved");

    await erc721.connect(user).approve(nftVault.address, index);

    await expect(
      nftVault.connect(user).borrow(index, borrowAmount.mul(2), false)
    ).to.be.revertedWith("InvalidAmount(" + borrowAmount.mul(2) + ")");

    const stablecoinBalanceBefore = await stablecoin.balanceOf(user.address);
    await nftVault.connect(user).borrow(index, borrowAmount.div(2), false);

    await expect(
      nftVault.borrow(index, borrowAmount, false)
    ).to.be.revertedWith("Unauthorized()");

    await nftVault.connect(user).borrow(index, borrowAmount.div(2), false);

    expect(await stablecoin.balanceOf(user.address)).to.be.equal(
      borrowAmount.mul(995).div(1000).add(stablecoinBalanceBefore)
    );

    expect(await nftVault.openPositionsIndexes()).to.deep.equal([
      BigNumber.from(index),
    ]);
    expect(await nftVault.totalPositions()).to.equal(1);
  });

  it("should be able to borrow with cig staked", async () => {
    await cigStaking.unpause();

    const index = 1000;
    const borrowAmount = units(3000).mul(50).mul(39).div(100);
    await erc721.mint(user.address, index);

    await erc721.connect(user).approve(nftVault.address, index);

    await expect(
      nftVault.connect(user).borrow(index, borrowAmount, false)
    ).to.be.revertedWith("InvalidAmount(" +  borrowAmount + ")");

    await erc721.mint(user.address, 200);
    await erc721.connect(user).approve(cigStaking.address, 200);
    await cigStaking.connect(user).deposit(200);

    await expect(
      nftVault.connect(user).borrow(index, borrowAmount.mul(2), false)
    ).to.be.revertedWith("InvalidAmount(" +  borrowAmount.mul(2) + ")");

    await nftVault.connect(user).borrow(index, borrowAmount, false);

    expect(await stablecoin.balanceOf(user.address)).to.be.equal(
      borrowAmount.mul(995).div(1000)
    );

    expect(await nftVault.openPositionsIndexes()).to.deep.equal([
      BigNumber.from(index),
    ]);
    expect(await nftVault.totalPositions()).to.equal(1);
  });

  it("credit limit rate should go back to normal after unstaking cig", async () => {
    await cigStaking.unpause();

    await erc721.mint(user.address, 200);
    await erc721.connect(user).approve(cigStaking.address, 200);
    await cigStaking.connect(user).deposit(200);

    const index = 1000;
    const borrowAmount = units(3000).mul(50).mul(39).div(100);
    await erc721.mint(user.address, index);
    await erc721.connect(user).approve(nftVault.address, index);
    await nftVault.connect(user).borrow(index, borrowAmount, false);

    expect(await nftVault.isLiquidatable(index)).to.be.false;
    expect(await nftVault.getCreditLimit(index)).to.equal(borrowAmount);
    
    await cigStaking.connect(user).withdraw(200);

    expect(await nftVault.isLiquidatable(index)).to.be.true;
    expect(await nftVault.getCreditLimit(index)).to.equal(units(3000).mul(50).mul(32).div(100));
  });


  it("should be able to borrow with insurance", async () => {
    const index = 2000;
    await erc721.mint(user.address, index);

    const borrowAmount = units(3000).mul(10);

    await erc721.connect(user).approve(nftVault.address, index);

    const stablecoinBalanceBefore = await stablecoin.balanceOf(user.address);
    const daoBalanceBefore = await stablecoin.balanceOf(dao.address);
    await nftVault.connect(user).borrow(index, borrowAmount, true);

    expect(await stablecoin.balanceOf(user.address)).to.be.equal(
      borrowAmount.mul(985).div(1000).add(stablecoinBalanceBefore)
    );
    await nftVault.connect(dao).collect();
    checkAlmostSame(
      await stablecoin.balanceOf(dao.address),
      borrowAmount.mul(15).div(1000).add(daoBalanceBefore)
    );
  });

  it("should be able to repay", async () => {
    await expect(nftVault.repay(10001, 100)).to.be.revertedWith("InvalidNFT(10001)");
    await erc721.mint(user.address, 1);
    await expect(nftVault.repay(1, 100)).to.be.revertedWith("Unauthorized()");

    const index = 3000;
    await erc721.mint(user.address, index);
    await expect(nftVault.connect(user).repay(index, 100)).to.be.revertedWith(
      "Unauthorized()"
    );

    await erc721.connect(user).approve(nftVault.address, index);
    await expect(nftVault.connect(user).repay(index, 100)).to.be.revertedWith(
      "Unauthorized()"
    );

    const borrowAmount = units(3000).mul(10);
    await nftVault.connect(user).borrow(index, borrowAmount, false);

    await expect(nftVault.connect(user).repay(index, 0)).to.be.revertedWith(
      "InvalidAmount(0)"
    );

    // pay half
    expect((await nftVault.positions(index)).debtPrincipal).to.be.equal(borrowAmount);

    let stablecoinBalanceBefore = await stablecoin.balanceOf(user.address);

    await stablecoin
      .connect(user)
      .approve(nftVault.address, borrowAmount.div(2));
    await nftVault.connect(user).repay(index, borrowAmount.div(2));

    checkAlmostSame((await nftVault.positions(index)).debtPrincipal, borrowAmount.div(2));

    expect(stablecoinBalanceBefore).to.be.equal(
      borrowAmount.div(2).add(await stablecoin.balanceOf(user.address))
    );

    // user prepares 30000 PUSD to repay full (consider interest)
    const prepareAmount = units(30000);
    await usdc.mint(dao.address, prepareAmount);
    await usdc.connect(dao).approve(usdcVault.address, prepareAmount);
    await usdcVault.connect(dao).deposit(prepareAmount);
    await usdcVault.connect(dao).borrow(prepareAmount);
    await stablecoin.connect(dao).transfer(user.address, prepareAmount);

    // pay half again
    stablecoinBalanceBefore = await stablecoin.balanceOf(user.address);
    await stablecoin
      .connect(user)
      .approve(nftVault.address, ethers.constants.MaxUint256);
    await nftVault.connect(user).repay(index, ethers.constants.MaxUint256);

    expect((await nftVault.positions(index)).debtPrincipal).to.be.equal(0);

    checkAlmostSame(
      stablecoinBalanceBefore,
      borrowAmount.div(2).add(await stablecoin.balanceOf(user.address))
    );
  });

  it("should allow the DAO to toggle the fallback oracle", async () => {
    await expect(nftVault.connect(dao).toggleFallbackOracle(true)).to.be.revertedWith("");
    await expect(nftVault.connect(dao).setFallbackOracle(ZERO_ADDRESS)).to.be.revertedWith("ZeroAddress()");

    await nftVault.connect(dao).setFallbackOracle(fallbackOracle.address);
    await nftVault.connect(dao).toggleFallbackOracle(true);
    const fallbackValueETH = await nftVault.getNFTValueETH(0);
    expect(fallbackValueETH).to.equal(units(10));
    await nftVault.connect(dao).toggleFallbackOracle(false);
    const nftValueETH = await nftVault.getNFTValueETH(0);
    expect(nftValueETH).to.equal(units(50));
  });

  it("should be able to close position", async () => {
    await expect(nftVault.closePosition(10001)).to.be.revertedWith(
      "InvalidNFT(10001)"
    );
    await erc721.mint(user.address, 1);
    await expect(nftVault.closePosition(1)).to.be.revertedWith("Unauthorized()");

    const index = 4000;
    await erc721.mint(user.address, index);

    await erc721.connect(user).approve(nftVault.address, index);

    const borrowAmount = units(3000).mul(10);
    await nftVault.connect(user).borrow(index, borrowAmount, false);

    await expect(nftVault.connect(user).closePosition(index)).to.be.reverted;
    try {
      await nftVault.connect(user).closePosition(index)
    } catch(err: any) {
      //doing it this way so we can get the exact debt interest
      expect(err.toString()).to.contain("NonZeroDebt(" + borrowAmount.add(await nftVault.getDebtInterest(index)) + ")")
    }

    // user prepares 30000 PUSD to repay full (consider interest)
    const prepareAmount = units(30000);
    await usdc.mint(dao.address, prepareAmount);
    await usdc.connect(dao).approve(usdcVault.address, prepareAmount);
    await usdcVault.connect(dao).deposit(prepareAmount);
    await usdcVault.connect(dao).borrow(prepareAmount);
    await stablecoin.connect(dao).transfer(user.address, prepareAmount);

    // full repay to close position
    await stablecoin
      .connect(user)
      .approve(nftVault.address, ethers.constants.MaxUint256);
    await nftVault.connect(user).repay(index, ethers.constants.MaxUint256);
    await nftVault.connect(user).closePosition(index);

    expect(await erc721.ownerOf(index)).to.be.equal(user.address);

    expect(await nftVault.positionOwner(index)).to.equal(ZERO_ADDRESS);

    expect(await nftVault.openPositionsIndexes()).to.deep.equal([]);
    expect(await nftVault.totalPositions()).to.equal(0);
  });

  it("should be able to liquidate borrow position without insurance", async () => {
    await expect(nftVault.connect(user).liquidate(10001, owner.address)).to.be.revertedWith(
      "AccessControl: account " +
        user.address.toLowerCase() +
        " is missing role " +
        liquidator_role
    );

    await expect(nftVault.connect(dao).liquidate(10001, owner.address)).to.be.revertedWith(
      "InvalidNFT(10001)"
    );

    const index = 4000;
    await erc721.mint(user.address, index);

    expect(await nftVault.positionOwner(index)).to.equal(ZERO_ADDRESS);

    await erc721.connect(user).approve(nftVault.address, index);

    expect(await nftVault.positionOwner(index)).to.equal(ZERO_ADDRESS);

    const borrowAmount = units(29000);
    await nftVault.connect(user).borrow(index, borrowAmount, false);

    await expect(nftVault.connect(dao).liquidate(index, owner.address)).to.be.revertedWith(
      "InvalidPosition(" + index + ")"
    );

    // dao prepares 30000 PUSD
    const prepareAmount = units(30000);
    await usdc.mint(dao.address, prepareAmount);
    await usdc.connect(dao).approve(usdcVault.address, prepareAmount);
    await usdcVault.connect(dao).deposit(prepareAmount);
    await usdcVault.connect(dao).borrow(prepareAmount);

    expect(await nftVault.isLiquidatable(index)).to.be.false;
    // treat to change eth price
    await ethOracle.updateAnswer(1000e8);
    expect(await nftVault.isLiquidatable(index)).to.be.true;

    await expect(nftVault.connect(dao).liquidate(index, owner.address)).to.be.revertedWith(
      "ERC20: insufficient allowance"
    );

    await stablecoin.connect(dao).approve(nftVault.address, units(30000));
    await nftVault.connect(dao).liquidate(index, owner.address);

    expect(await stablecoin.balanceOf(dao.address)).to.be.gt(0);

    expect(await erc721.ownerOf(index)).to.be.equal(owner.address);

    expect(await nftVault.positionOwner(index)).to.equal(ZERO_ADDRESS);

    // treat to change back eth price
    await ethOracle.updateAnswer(3000e8);

    expect(await nftVault.openPositionsIndexes()).to.deep.equal([]);
    expect(await nftVault.totalPositions()).to.equal(0);
  });

  it("should be able to liquidate borrow position with insurance", async () => {
    const index = 6000;
    await erc721.mint(user.address, index);

    await erc721.connect(user).approve(nftVault.address, index);
    const borrowAmount = units(2000);
    await nftVault.connect(user).borrow(index, borrowAmount, true);

    // dao prepares 30000 PUSD
    const prepareAmount = units(30000);
    await usdc.mint(dao.address, prepareAmount);
    await usdc.connect(dao).approve(usdcVault.address, prepareAmount);
    await usdcVault.connect(dao).deposit(prepareAmount);
    await usdcVault.connect(dao).borrow(prepareAmount);

    // treat to change eth price
    await ethOracle.updateAnswer(100e8);

    await expect(nftVault.connect(dao).liquidate(index, owner.address)).to.be.revertedWith(
      "ERC20: insufficient allowance"
    );

    await stablecoin.connect(dao).approve(nftVault.address, units(30000));
    await nftVault.connect(dao).liquidate(index, owner.address);

    await expect(nftVault.connect(dao).liquidate(index, owner.address)).to.be.revertedWith(
      "PositionLiquidated(" + index + ")"
    );

    expect(await erc721.ownerOf(index)).to.be.equal(nftVault.address);

    expect((await nftVault.positions(index)).liquidatedAt).to.be.gt(0);
    await expect(
      nftVault.connect(user).borrow(index, borrowAmount, false)
    ).to.be.revertedWith("PositionLiquidated(" + index + ")");
    await expect(
      nftVault.connect(user).repay(index, borrowAmount)
    ).to.be.revertedWith("PositionLiquidated(" + index + ")");

    // treat to change back eth price
    await ethOracle.updateAnswer(3000e8);

    expect(await nftVault.openPositionsIndexes()).to.deep.equal([
      BigNumber.from(index),
    ]);
    expect(await nftVault.totalPositions()).to.equal(1);
  });

  it("should be able to liquidate borrow position with staked cig", async () => {
    await cigStaking.unpause();
    
    await erc721.mint(user.address, 200);
    await erc721.connect(user).approve(cigStaking.address, 200);
    await cigStaking.connect(user).deposit(200);

    const index = 1000;
    const borrowAmount = units(3000).mul(50).mul(39).div(100);
    await erc721.mint(user.address, index);
    await erc721.connect(user).approve(nftVault.address, index);
    await nftVault.connect(user).borrow(index, borrowAmount, false);

    await expect(nftVault.connect(user).liquidate(10001, owner.address)).to.be.revertedWith(
      "AccessControl: account " +
        user.address.toLowerCase() +
        " is missing role " +
        liquidator_role
    );

    await expect(nftVault.connect(dao).liquidate(10001, owner.address)).to.be.revertedWith(
      "InvalidNFT(10001)"
    );

    await expect(nftVault.connect(dao).liquidate(index, owner.address)).to.be.revertedWith(
      "InvalidPosition(" + index + ")"
    );
    
    const liquidationCost = borrowAmount.add(units(1));
    await usdc.mint(dao.address, liquidationCost);
    await usdc.connect(dao).approve(usdcVault.address, liquidationCost);
    await usdcVault.connect(dao).deposit(liquidationCost);
    await usdcVault.connect(dao).borrow(liquidationCost);

    await ethOracle.updateAnswer(2900e8);
    expect(await nftVault.isLiquidatable(index)).to.be.true;

    await stablecoin.connect(dao).approve(nftVault.address, liquidationCost);
    await nftVault.connect(dao).liquidate(index, owner.address);

    expect(await stablecoin.balanceOf(dao.address)).to.be.gt(0);

    expect(await erc721.ownerOf(index)).to.be.equal(owner.address);

    expect(await nftVault.positionOwner(index)).to.equal(ZERO_ADDRESS);

    // treat to change back eth price
    await ethOracle.updateAnswer(3000e8);

    expect(await nftVault.openPositionsIndexes()).to.deep.equal([]);
    expect(await nftVault.totalPositions()).to.equal(0);
  });

  it("shouldn't allow closing liquidated positions with insurance without repaying", async () => {
    const index = 6000;
    await erc721.mint(user.address, index);

    await erc721.connect(user).approve(nftVault.address, index);
    const borrowAmount = units(2000);
    await nftVault.connect(user).borrow(index, borrowAmount, true);

    // dao prepares 30000 PUSD
    const prepareAmount = units(30000);
    await usdc.mint(dao.address, prepareAmount);
    await usdc.connect(dao).approve(usdcVault.address, prepareAmount);
    await usdcVault.connect(dao).deposit(prepareAmount);
    await usdcVault.connect(dao).borrow(prepareAmount);

    // treat to change eth price
    await ethOracle.updateAnswer(100e8);

    await stablecoin.connect(dao).approve(nftVault.address, units(30000));
    await nftVault.connect(dao).liquidate(index, owner.address);

    await expect(nftVault.connect(user).closePosition(index)).to.be.revertedWith("PositionLiquidated(" + index + ")");
  });

  it("should be able to repurchase", async () => {
    await expect(nftVault.repurchase(10001)).to.be.revertedWith("InvalidNFT(10001)");
    await erc721.mint(owner.address, 1);
    await expect(nftVault.repurchase(1)).to.be.revertedWith("Unauthorized()");

    const index = 5000;
    await erc721.mint(user.address, index);
    await erc721.connect(user).approve(nftVault.address, index);
    const borrowAmount = units(3000).mul(10);
    await nftVault.connect(user).borrow(index, borrowAmount, true);

    const initialTimestamp = await currentTimestamp();

    await expect(nftVault.connect(user).repurchase(index)).to.be.revertedWith(
      "InvalidPosition(" + index + ")"
    );

    // dao prepares 70000 PUSD
    const prepareAmount = units(70000);
    await usdc.mint(dao.address, prepareAmount);
    await usdc.connect(dao).approve(usdcVault.address, prepareAmount);
    await usdcVault.connect(dao).deposit(prepareAmount);
    await usdcVault.connect(dao).borrow(prepareAmount);

    // treat to change eth price
    await ethOracle.updateAnswer(100e8);

    await stablecoin.connect(dao).approve(nftVault.address, units(70000));
    await nftVault.connect(dao).liquidate(index, owner.address);

    const elapsed = (await currentTimestamp()) - initialTimestamp;
    const totalDebt = borrowAmount.add(
      borrowAmount
        .mul(2)
        .mul(elapsed)
        .div(100)
        .div(86400 * 365)
    );
    const toRepurchase = totalDebt.add(totalDebt.mul(25).div(100));

    await stablecoin.connect(dao).transfer(user.address, toRepurchase);
    await stablecoin.connect(user).approve(nftVault.address, toRepurchase);

    await nftVault.connect(user).repurchase(index);

    expect(
      await stablecoin.allowance(user.address, nftVault.address)
    ).to.be.closeTo(units(0), units(1) as any);

    expect(await nftVault.openPositionsIndexes()).to.deep.equal([]);
    expect(await nftVault.totalPositions()).to.equal(0);
  });

  it("should allow the DAO to set JPEG oracle", async () => {
    await expect(nftVault.connect(dao).setjpegOracle(ZERO_ADDRESS)).to.be.revertedWith("ZeroAddress()");
    await nftVault.connect(dao).setjpegOracle(jpegOracle.address);
  });

  it("should allow the liquidator to claim an nft with expired insurance", async () => {
    const index = 5000;
    await erc721.mint(user.address, index);
    await erc721.connect(user).approve(nftVault.address, index);
    const borrowAmount = units(3000).mul(10);
    await nftVault.connect(user).borrow(index, borrowAmount, true);

    const initialTimestamp = await currentTimestamp();

    // dao prepares 70000 PUSD
    const prepareAmount = units(70000);
    await usdc.mint(dao.address, prepareAmount);
    await usdc.connect(dao).approve(usdcVault.address, prepareAmount);
    await usdcVault.connect(dao).deposit(prepareAmount);
    await usdcVault.connect(dao).borrow(prepareAmount);

    // treat to change eth price
    await ethOracle.updateAnswer(100e8);

    await stablecoin.connect(dao).approve(nftVault.address, units(70000));
    await expect(
      nftVault.connect(dao).claimExpiredInsuranceNFT(index, owner.address)
    ).to.be.revertedWith("InvalidPosition(" + index + ")");
    await nftVault.connect(dao).liquidate(index, owner.address);

    const elapsed = (await currentTimestamp()) - initialTimestamp;
    const totalDebt = borrowAmount.add(
      borrowAmount
        .mul(2)
        .mul(elapsed)
        .div(100)
        .div(86400 * 365)
    );
    const toRepurchase = totalDebt.add(totalDebt.mul(25).div(100));

    await stablecoin.connect(dao).transfer(user.address, toRepurchase);
    await stablecoin.connect(user).approve(nftVault.address, toRepurchase);

    await expect(
      nftVault.connect(dao).claimExpiredInsuranceNFT(index, owner.address)
    ).to.be.revertedWith("PositionInsuranceNotExpired(" + index + ")");

    await timeTravel(86400 * 3);

    await expect(nftVault.connect(user).repurchase(index)).to.be.revertedWith(
      "PositionInsuranceExpired(" + index + ")"
    );

    await expect(nftVault.claimExpiredInsuranceNFT(index, owner.address)).to.be.revertedWith(
      "Unauthorized()"
    );

    await nftVault.connect(dao).claimExpiredInsuranceNFT(index, owner.address);
    expect(await erc721.ownerOf(index)).to.equal(owner.address);
    await expect(
      nftVault.connect(dao).claimExpiredInsuranceNFT(index, owner.address)
    ).to.be.revertedWith("InvalidPosition(" + index + ")");

    expect(await nftVault.openPositionsIndexes()).to.deep.equal([]);
    expect(await nftVault.totalPositions()).to.equal(0);
  });

  it("should allow users to lock JPEG to unlock trait boosts", async () => {
    await erc721.mint(user.address, 0);
    await expect(nftVault.applyTraitBoost(0, 0)).to.be.revertedWith("InvalidNFTType(\"" + default_admin_role + "\")");

    const index = apes[2];

    await erc721.mint(user.address, index);

    await erc721.connect(user).approve(nftVault.address, index);

    expect(await nftVault.getNFTValueUSD(index)).to.equal(units(150000));

    await expect(nftVault.applyTraitBoost(index, 0)).to.be.revertedWith("InvalidUnlockTime(0)");

    const timestamp = (await ethers.provider.getBlock("latest")).timestamp;

    await expect(nftVault.connect(user).applyTraitBoost(index, timestamp + 1000)).to.be.revertedWith("NoOracleSet()");

    await nftVault.connect(dao).setjpegOracle(jpegOracle.address);

    await jpeg.mint(user.address, units(40000));
    await jpeg.connect(user).approve(nftVault.address, units(40000));

    await nftVault.connect(user).applyTraitBoost(index, timestamp + 1000);

    expect(await nftVault.getNFTValueUSD(index)).to.equal(units(1500000));

    expect(await jpeg.balanceOf(user.address)).to.equal(0);
    expect(await jpeg.balanceOf(nftVault.address)).to.equal(units(40000));

    await expect(nftVault.unlockJPEG(index)).to.be.revertedWith("Unauthorized()");
    await expect(nftVault.connect(user).unlockJPEG(index)).to.be.revertedWith("Unauthorized()");

    await timeTravel(1000);

    expect(await nftVault.getNFTValueUSD(index)).to.equal(units(150000));

    await nftVault.connect(user).unlockJPEG(index);
  });

  it("should allow users to execute multiple actions in one call", async () => {
    const index1 = apes[2];
    const index2 = 7000;

    const borrowAmount1 = units(150000);
    const borrowAmount2 = units(20000);

    await erc721.mint(user.address, index1);
    await erc721.mint(user.address, index2);
    await erc721.connect(user).setApprovalForAll(nftVault.address, true);

    await nftVault.connect(dao).setjpegOracle(jpegOracle.address);

    await jpeg.mint(user.address, units(40000));
    await jpeg.connect(user).approve(nftVault.address, units(40000));

    await stablecoin.connect(user).approve(nftVault.address, borrowAmount1);

    const unlockTime = await currentTimestamp() + 1000;

    const abiCoder = new AbiCoder();
  
    await nftVault.connect(user).doActions(
      [102, 0, 0, 1, 2],
      [
        abiCoder.encode(["uint256", "uint256"], [index1, unlockTime]),
        abiCoder.encode(["uint256", "uint256", "bool"], [index1, borrowAmount1, true]),
        abiCoder.encode(["uint256", "uint256", "bool"], [index2, borrowAmount2, false]),
        abiCoder.encode(["uint256", "uint256"], [index2, borrowAmount1]),
        abiCoder.encode(["uint256"], [index2])
      ]
    );

    const lock = await nftVault.lockPositions(index1);
    expect(lock.owner).to.equal(user.address);
    expect(lock.lockedValue).to.equal(units(40000));
    expect(lock.unlockAt).to.equal(unlockTime);

    expect((await nftVault.positions(index1)).debtPrincipal).to.equal(borrowAmount1);
    expect((await nftVault.positions(index2)).debtPrincipal).to.equal(0);

    expect((await erc721.ownerOf(index2))).to.equal(user.address);
  });

  it("should allow users to override JPEG locks", async () => {
    const index = apes[2];
    await erc721.mint(user.address, index);
    await erc721.connect(user).approve(nftVault.address, index);
    await nftVault.connect(dao).setjpegOracle(jpegOracle.address);

    await jpeg.mint(user.address, units(80000));
    await jpeg.connect(user).approve(nftVault.address, units(800000));

    const timestamp = (await ethers.provider.getBlock("latest")).timestamp;
    await nftVault.connect(user).applyTraitBoost(index, timestamp + 1000);

    expect(await jpeg.balanceOf(user.address)).to.equal(units(40000));
    expect(await jpeg.balanceOf(nftVault.address)).to.equal(units(40000));

    await jpegOracle.setPrice(2000000000000000);

    await expect(nftVault.connect(user).applyTraitBoost(index, timestamp + 1000)).to.be.revertedWith("InvalidUnlockTime(" + (timestamp + 1000) + ")");

    await nftVault.connect(user).applyTraitBoost(index, timestamp + 1001);

    expect(await jpeg.balanceOf(user.address)).to.equal(units(60000));
    expect(await jpeg.balanceOf(nftVault.address)).to.equal(units(20000));

    await jpegOracle.setPrice(500000000000000);

    await nftVault.connect(user).applyTraitBoost(index, timestamp + 1002);

    expect(await jpeg.balanceOf(user.address)).to.equal(0);
    expect(await jpeg.balanceOf(nftVault.address)).to.equal(units(80000));

    await jpeg.mint(dao.address, units(80000));
    await jpeg.connect(dao).approve(nftVault.address, units(800000));

    await nftVault.connect(dao).applyTraitBoost(index, timestamp + 1003);

    expect(await jpeg.balanceOf(user.address)).to.equal(units(80000));
    expect(await jpeg.balanceOf(nftVault.address)).to.equal(units(80000));
    expect(await jpeg.balanceOf(dao.address)).to.equal(0);
  });

  it("organization is deducted from debt", async () => {
    const index = 8000;

    await erc721.mint(user.address, index);
    await erc721.connect(user).approve(nftVault.address, index);

    const balanceBefore = await stablecoin.balanceOf(user.address);
    await nftVault.connect(user).borrow(index, units(3000).mul(10), false);
    expect(await stablecoin.balanceOf(user.address)).to.equal(
      balanceBefore.add(units(3000).mul(10).mul(995).div(1000))
    );
  });

  it("insurance fee is deducted from debt", async () => {
    const index = 9000;

    await erc721.mint(user.address, index);
    await erc721.connect(user).approve(nftVault.address, index);

    const balanceBefore = await stablecoin.balanceOf(user.address);
    await nftVault.connect(user).borrow(index, units(3000).mul(10), true);
    expect(await stablecoin.balanceOf(user.address)).to.equal(
      balanceBefore.add(units(3000).mul(10).mul(985).div(1000))
    );
  });

  it("collect mints interest and send to dao", async () => {
    const index = 200;
    const borrowAmount = units(3000).mul(10);
    await erc721.mint(user.address, index);
    await erc721.connect(user).approve(nftVault.address, index);
    await nftVault.connect(user).borrow(index, borrowAmount, true);
    await nftVault.connect(dao).collect();

    await timeTravel(days(1));

    let balanceBefore = await stablecoin.balanceOf(dao.address);
    await nftVault.connect(dao).collect();
    const mintedFee = (await stablecoin.balanceOf(dao.address)).sub(
      balanceBefore
    );
    checkAlmostSame(mintedFee, borrowAmount.mul(2).div(100).div(365));

    await stablecoin.connect(dao).transfer(user.address, mintedFee);

    // user prepares 30000 PUSD to repay full (consider interest)
    const prepareAmount = units(30000);
    await usdc.mint(dao.address, prepareAmount);
    await usdc.connect(dao).approve(usdcVault.address, prepareAmount);
    await usdcVault.connect(dao).deposit(prepareAmount);
    await usdcVault.connect(dao).borrow(prepareAmount);
    await stablecoin.connect(dao).transfer(user.address, prepareAmount);

    // no fee transfer when repay after collect
    balanceBefore = await stablecoin.balanceOf(dao.address);
    await stablecoin
      .connect(user)
      .approve(nftVault.address, borrowAmount.add(mintedFee.mul(2)));
    await nftVault
      .connect(user)
      .repay(index, borrowAmount.add(mintedFee.mul(2)));
    expect(await stablecoin.balanceOf(dao.address)).to.equal(balanceBefore);

    expect((await nftVault.positions(index)).debtPrincipal).to.be.equal(0);
    expect(await nftVault.getDebtInterest(index)).to.be.equal(0);
  });

  it("should allow the dao to override floor price", async () => {
    await erc721.mint(owner.address, 0);
    await nftVault.connect(dao).overrideFloor(units(10));
    await erc721.approve(nftVault.address, 0);
    await nftVault.borrow(0, 1, false);
    expect(await nftVault.getNFTValueUSD(0)).to.equal(units(10).mul(3000));
    await nftVault.connect(dao).disableFloorOverride();
    expect(await nftVault.getNFTValueUSD(0)).to.equal(units(50).mul(3000));
  });

  it("should allow the dao to set nftType", async () => {
    await erc721.mint(owner.address, 0);
    await expect(nftVault.setNFTType([0], apeHash)).to.be.revertedWith(
      "AccessControl: account " +
        owner.address.toLowerCase() +
        " is missing role " +
        dao_role
    );

    await expect(
      nftVault.connect(dao).setNFTType([0], dao_role)
    ).to.be.revertedWith("InvalidNFTType(\"" + dao_role + "\")");

    await nftVault.connect(dao).setNFTType([0], apeHash);
    expect(await nftVault.nftTypes(0)).to.equal(apeHash);
  });

  it("should allow the dao to set the value of an nft type", async () => {
    await erc721.mint(owner.address, 0);
    await expect(nftVault.setNFTTypeMultiplier(apeHash, { numerator: 100, denominator: 1 })).to.be.revertedWith(
      "AccessControl: account " +
        owner.address.toLowerCase() +
        " is missing role " +
        dao_role
    );

    await nftVault.connect(dao).setNFTTypeMultiplier(apeHash, { numerator: 100, denominator: 1 });
  });
});
