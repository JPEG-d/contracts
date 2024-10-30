import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber, BigNumberish } from "ethers";
import { ethers, upgrades } from "hardhat";
import {
    JPEGCardsCigStaking,
    MockNFTValueProviderMigration,
    JPGD,
    TestERC721
} from "../types";
import {
    units,
    bn,
    timeTravel,
    setNextTimestamp,
    currentTimestamp,
    ZERO_ADDRESS
} from "./utils";
import { MockV3Aggregator } from "../types/MockV3Aggregator";
import { JPEG } from "../types/JPEG";

const apeHash =
    "0x26bca2ecad19e981c90a8c6efd8ee9856bbc5a2042259e6ee31e310fdc08d970";
const minterRole =
    "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const zeroHash =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

const baseCreditLimitRate = [60, 100];
const baseLiquidationLimitRate = [70, 100];
const cigBoostRateIncrease = [10, 100];
const ltvBoostMaxRateIncrease = [2000, 10000];
const traitBoostLockRate = [35, 100];
const ltvBoostLockRate = [2_000, 10_000];
const ltvRateCap = [80, 100];
const liquidationRateCap = [81, 100];
const locksReleaseDelay = 7 * 86400;

const jpgdTokenPrice = bn("1000000000000000");
const floor = units(50);

const jpgdSupply = bn("100000000000000000000000000000");
const jpegSupply = bn("69420000000000000000000000000");

function sumRates(r1: BigNumberish[], ...remaining: BigNumberish[][]) {
    return remaining.reduce<BigNumber[]>(
        (p, c) => [p[0].mul(c[1]).add(p[1].mul(c[0])), p[1].mul(c[1])],
        [bn(r1[0]), bn(r1[1])]
    );
}

describe("NFTValueProvider", () => {
    let owner: SignerWithAddress, user: SignerWithAddress;
    let nftValueProvider: MockNFTValueProviderMigration,
        nftTokenOracle: MockV3Aggregator,
        cigStaking: JPEGCardsCigStaking,
        erc721: TestERC721,
        jpgdToken: JPGD;

    beforeEach(async () => {
        const accounts = await ethers.getSigners();
        owner = accounts[0];
        user = accounts[1];

        const MockOracle = await ethers.getContractFactory(
            "UniswapV2MockOracle"
        );
        const jpegOracle = await MockOracle.deploy(jpgdTokenPrice);
        await jpegOracle.deployed();

        const MockAggregator = await ethers.getContractFactory(
            "MockV3Aggregator"
        );
        const floorOracle = await MockAggregator.deploy(18, floor);
        await floorOracle.deployed();

        nftTokenOracle = await MockAggregator.deploy(18, jpgdTokenPrice);
        await nftTokenOracle.deployed();

        const JPGD = await ethers.getContractFactory("JPGD");

        jpgdToken = await JPGD.deploy();
        await jpgdToken.deployed();

        await jpgdToken.grantRole(minterRole, owner.address);

        const JPEGOraclesAggregator = await ethers.getContractFactory(
            "JPEGOraclesAggregator"
        );
        let jpegOraclesAggregator = await JPEGOraclesAggregator.deploy(
            jpegOracle.address
        );

        const ERC721 = await ethers.getContractFactory("TestERC721");
        erc721 = await ERC721.deploy();
        await erc721.deployed();

        const CigStaking = await ethers.getContractFactory(
            "JPEGCardsCigStaking"
        );
        cigStaking = await CigStaking.deploy(erc721.address, [200]);
        await cigStaking.deployed();

        const NFTValueProvider = await ethers.getContractFactory(
            "MockNFTValueProviderMigration"
        );
        nftValueProvider = <MockNFTValueProviderMigration>(
            await upgrades.deployProxy(NFTValueProvider, [
                jpgdToken.address,
                nftTokenOracle.address,
                jpegOraclesAggregator.address,
                cigStaking.address,
                [
                    baseCreditLimitRate,
                    baseLiquidationLimitRate,
                    cigBoostRateIncrease,
                    ltvBoostMaxRateIncrease,
                    traitBoostLockRate,
                    ltvBoostLockRate,
                    ltvRateCap,
                    liquidationRateCap
                ],
                locksReleaseDelay
            ])
        );
        await nftValueProvider.deployed();

        await jpegOraclesAggregator.addFloorOracle(
            floorOracle.address,
            nftValueProvider.address
        );
    });

    it("should return the collection's floor price when calling getFloorETH", async () => {
        expect(await nftValueProvider.getFloorETH()).to.equal(floor);
    });

    it("should return the collection's floor price when calling getNFTValueETH with a floor JPGD", async () => {
        expect(await nftValueProvider.getNFTValueETH(0)).to.equal(floor);
    });

    it("should allow the owner to set an nft type and its multiplier", async () => {
        await expect(nftValueProvider.connect(user).setNFTType([0], apeHash)).to
            .be.reverted;
        await expect(
            nftValueProvider.connect(user).setNFTTypeMultiplier(apeHash, {
                numerator: 10,
                denominator: 1
            })
        ).to.be.reverted;

        await nftValueProvider.setNFTTypeMultiplier(apeHash, {
            numerator: 10,
            denominator: 1
        });
        await nftValueProvider.setNFTType([0], apeHash);

        expect(
            await nftValueProvider.nftTypeValueMultiplier(apeHash)
        ).to.deep.equal([bn(10), bn(1)]);
        expect(await nftValueProvider.nftTypes(0)).to.equal(apeHash);
    });

    it("should return the correct credit and liquidation limits", async () => {
        expect(
            await nftValueProvider.getCreditLimitETH(owner.address, 0)
        ).to.equal(
            floor.mul(baseCreditLimitRate[0]).div(baseCreditLimitRate[1])
        );
        expect(
            await nftValueProvider.getLiquidationLimitETH(owner.address, 0)
        ).to.equal(
            floor
                .mul(baseLiquidationLimitRate[0])
                .div(baseLiquidationLimitRate[1])
        );
    });

    it("should increase credit and liquidation limits after staking cig", async () => {
        await cigStaking.unpause();

        await erc721.mint(user.address, 200);
        await erc721.connect(user).approve(cigStaking.address, 200);
        await cigStaking.connect(user).deposit(200);

        expect(
            await nftValueProvider.getCreditLimitRate(user.address, 0)
        ).to.deep.equal(sumRates(baseCreditLimitRate, cigBoostRateIncrease));

        expect(
            await nftValueProvider.getLiquidationLimitRate(user.address, 0)
        ).to.deep.equal(
            sumRates(baseLiquidationLimitRate, cigBoostRateIncrease)
        );
    });

    it("should decrease credit and liquidation limits after unstaking cig", async () => {
        await cigStaking.unpause();

        await erc721.mint(user.address, 200);
        await erc721.connect(user).approve(cigStaking.address, 200);
        await cigStaking.connect(user).deposit(200);

        await cigStaking.connect(user).withdraw(200);

        expect(
            await nftValueProvider.getCreditLimitRate(user.address, 0)
        ).to.deep.equal([
            bn(baseCreditLimitRate[0]),
            bn(baseCreditLimitRate[1])
        ]);
        expect(
            await nftValueProvider.getLiquidationLimitRate(user.address, 0)
        ).to.deep.equal([
            bn(baseLiquidationLimitRate[0]),
            bn(baseLiquidationLimitRate[1])
        ]);
    });

    it("should allow users to lock JPEG for trait boosts", async () => {
        const indexes = [100, 101, 102];

        await nftValueProvider.setNFTTypeMultiplier(apeHash, {
            numerator: 10,
            denominator: 1
        });
        await nftValueProvider.setNFTType(indexes, apeHash);

        await expect(
            nftValueProvider.applyTraitBoost([])
        ).to.be.revertedWithCustomError(nftValueProvider, "InvalidLength");

        await expect(
            nftValueProvider.applyTraitBoost([0])
        ).to.be.revertedWithCustomError(nftValueProvider, "InvalidNFTType");

        const jpegToLock = floor
            .mul(10)
            .sub(floor)
            .mul(traitBoostLockRate[0])
            .div(traitBoostLockRate[1])
            .mul(units(1))
            .div(jpgdTokenPrice);

        expect(
            await nftValueProvider.calculateTraitBoostLock(
                apeHash,
                jpgdTokenPrice
            )
        ).to.equal(jpegToLock);

        await jpgdToken.mint(user.address, jpegToLock.mul(indexes.length));
        await jpgdToken
            .connect(user)
            .approve(nftValueProvider.address, jpegToLock.mul(indexes.length));

        await nftValueProvider.connect(user).applyTraitBoost(indexes);

        await expect(
            nftValueProvider.connect(user).applyTraitBoost(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "LockExists");

        await expect(
            nftValueProvider.applyTraitBoost(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "LockExists");

        expect(
            await Promise.all(
                indexes.map(i => nftValueProvider.traitBoostPositions(i))
            )
        ).to.deep.equal(
            new Array(indexes.length).fill([
                user.address,
                bn(0),
                jpegToLock,
                true
            ])
        );

        expect(
            await Promise.all(
                indexes.map(i => nftValueProvider.getNFTValueETH(i))
            )
        ).to.deep.equal(new Array(indexes.length).fill(floor.mul(10)));

        expect(await jpgdToken.balanceOf(user.address)).to.equal(0);
        expect(await jpgdToken.balanceOf(nftValueProvider.address)).to.equal(
            jpegToLock.mul(indexes.length)
        );

        await expect(
            nftValueProvider.withdrawTraitBoost(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");
        await expect(
            nftValueProvider.connect(user).withdrawTraitBoost(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");
    });

    it("should allow users to lock JPEG for LTV boosts", async () => {
        const indexes = [100, 101, 102];
        const rateIncreases = [1000, 500, 250];

        const boostedCreditLimitRates = rateIncreases.map(r =>
            sumRates([r, 10_000], baseCreditLimitRate)
        );
        const boostedLiquidationLimitRates = rateIncreases.map(r =>
            sumRates([r, 10_000], baseLiquidationLimitRate)
        );

        const jpegAmounts = boostedCreditLimitRates.map(b => {
            const baseCreditLimit = floor
                .mul(baseCreditLimitRate[0])
                .div(baseCreditLimitRate[1]);

            const boostedCreditLimit = floor.mul(b[0]).div(b[1]);

            return boostedCreditLimit
                .sub(baseCreditLimit)
                .mul(ltvBoostLockRate[0])
                .div(ltvBoostLockRate[1])
                .mul(units(1))
                .div(jpgdTokenPrice);
        });

        const totalJpegAmount = jpegAmounts.reduce((p, c) => p.add(c));

        expect(
            await Promise.all(
                rateIncreases.map(r =>
                    nftValueProvider.calculateLTVBoostLock(jpgdTokenPrice, r)
                )
            )
        ).to.deep.equal(jpegAmounts);

        await expect(
            nftValueProvider.applyLTVBoost(indexes, [0])
        ).to.be.revertedWithCustomError(nftValueProvider, "InvalidLength");
        await expect(
            nftValueProvider.applyLTVBoost(indexes, [0, 0, 0])
        ).to.be.revertedWithCustomError(nftValueProvider, "InvalidAmount");
        await expect(
            nftValueProvider.applyLTVBoost(indexes, [11000, 0, 0])
        ).to.be.revertedWithCustomError(nftValueProvider, "InvalidAmount");
        await expect(
            nftValueProvider.applyLTVBoost(indexes, [3000, 0, 0])
        ).to.be.revertedWithCustomError(nftValueProvider, "InvalidRate");

        await jpgdToken.mint(user.address, totalJpegAmount);
        await jpgdToken
            .connect(user)
            .approve(nftValueProvider.address, totalJpegAmount);

        await nftValueProvider
            .connect(user)
            .applyLTVBoost(indexes, rateIncreases);

        await expect(
            nftValueProvider.connect(user).applyLTVBoost(indexes, rateIncreases)
        ).to.be.revertedWithCustomError(nftValueProvider, "LockExists");

        await expect(
            nftValueProvider.applyLTVBoost(indexes, rateIncreases)
        ).to.be.revertedWithCustomError(nftValueProvider, "LockExists");

        expect(
            await Promise.all(
                indexes.map(i => nftValueProvider.ltvBoostPositions(i))
            )
        ).to.deep.equal(jpegAmounts.map(a => [user.address, bn(0), a, true]));

        expect(
            await Promise.all(
                indexes.map(i =>
                    nftValueProvider.getCreditLimitRate(user.address, i)
                )
            )
        ).to.deep.equal(boostedCreditLimitRates);

        expect(
            await Promise.all(
                indexes.map(i =>
                    nftValueProvider.getLiquidationLimitRate(user.address, i)
                )
            )
        ).to.deep.equal(boostedLiquidationLimitRates);

        expect(await jpgdToken.balanceOf(user.address)).to.equal(0);
        expect(await jpgdToken.balanceOf(nftValueProvider.address)).to.equal(
            totalJpegAmount
        );

        await expect(
            nftValueProvider.connect(user).withdrawLTVBoost(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        await expect(
            nftValueProvider.withdrawLTVBoost(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");
    });

    it("should allow increasing LTV locks", async () => {
        const indexes = [100, 101, 102];

        const rateIncreases = [
            ltvBoostMaxRateIncrease[0],
            ltvBoostMaxRateIncrease[0] / 2,
            ltvBoostMaxRateIncrease[0] / 4
        ];

        const jpegAmounts = await Promise.all(
            rateIncreases.map(r =>
                nftValueProvider.calculateLTVBoostLock(jpgdTokenPrice, r)
            )
        );

        let totalJpegAmount = jpegAmounts.reduce((p, c) => p.add(c));

        await jpgdToken.mint(user.address, totalJpegAmount);
        await jpgdToken
            .connect(user)
            .approve(nftValueProvider.address, totalJpegAmount);

        await nftValueProvider
            .connect(user)
            .applyLTVBoost(indexes, rateIncreases);

        await expect(
            nftValueProvider.connect(user).applyLTVBoost(indexes, rateIncreases)
        ).to.be.revertedWithCustomError(nftValueProvider, "LockExists");

        let newIncreases = rateIncreases.map(r => r * 2);

        await expect(
            nftValueProvider.connect(user).applyLTVBoost(indexes, newIncreases)
        ).to.be.revertedWithCustomError(nftValueProvider, "InvalidRate");

        newIncreases = newIncreases.slice(1);

        const newJpegAmount = jpegAmounts.slice(1).reduce((p, c) => p.add(c));

        await jpgdToken.mint(user.address, newJpegAmount);
        await jpgdToken
            .connect(user)
            .approve(nftValueProvider.address, newJpegAmount);

        await nftValueProvider
            .connect(user)
            .applyLTVBoost(indexes.slice(1), newIncreases);

        expect(
            await Promise.all(
                indexes
                    .slice(1)
                    .map(i =>
                        nftValueProvider.getCreditLimitRate(user.address, i)
                    )
            )
        ).to.deep.equal(
            newIncreases.map(r => sumRates([r, 10_000], baseCreditLimitRate))
        );

        expect(await jpgdToken.balanceOf(user.address)).to.equal(0);

        await nftTokenOracle.updateAnswer(jpgdTokenPrice.mul(4));

        await expect(
            nftValueProvider
                .connect(user)
                .applyLTVBoost([indexes[1]], [newIncreases[0] * 2])
        ).to.be.revertedWithCustomError(nftValueProvider, "InvalidRate");

        await expect(
            nftValueProvider.applyLTVBoost([indexes[2]], [newIncreases[1] * 2])
        ).to.be.revertedWithCustomError(nftValueProvider, "LockExists");

        await nftValueProvider
            .connect(user)
            .applyLTVBoost([indexes[2]], [newIncreases[1] * 2]);

        expect(
            await nftValueProvider.getCreditLimitRate(user.address, indexes[1])
        ).to.deep.equal(
            sumRates([newIncreases[1] * 2, 10_000], baseCreditLimitRate)
        );
    });

    it("should allow queueing releases for trait boost locks", async () => {
        const indexes = [100, 101, 102];

        await nftValueProvider.setNFTTypeMultiplier(apeHash, {
            numerator: 10,
            denominator: 1
        });
        await nftValueProvider.setNFTType(indexes, apeHash);

        const jpegAmounts = await Promise.all(
            indexes.map(() =>
                nftValueProvider.calculateTraitBoostLock(
                    apeHash,
                    jpgdTokenPrice
                )
            )
        );

        const totalJpegAmount = jpegAmounts.reduce((p, c) => p.add(c));

        await jpgdToken.mint(user.address, totalJpegAmount);
        await jpgdToken
            .connect(user)
            .approve(nftValueProvider.address, totalJpegAmount);

        await nftValueProvider.connect(user).applyTraitBoost(indexes);

        await expect(
            nftValueProvider.queueTraitBoostRelease(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        const startTimestamp = (await currentTimestamp()) + 1;
        await setNextTimestamp(startTimestamp);

        await nftValueProvider.connect(user).queueTraitBoostRelease(indexes);

        await expect(
            nftValueProvider.connect(user).queueTraitBoostRelease(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        expect(
            await Promise.all(
                indexes.map(i => nftValueProvider.traitBoostPositions(i))
            )
        ).to.deep.equal(
            jpegAmounts.map(a => [
                user.address,
                bn(startTimestamp + locksReleaseDelay),
                a,
                true
            ])
        );

        await expect(
            nftValueProvider.connect(user).withdrawTraitBoost(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        expect(
            await Promise.all(
                indexes.map(i => nftValueProvider.getNFTValueETH(i))
            )
        ).to.deep.equal(new Array(indexes.length).fill(floor.mul(10)));

        await timeTravel(locksReleaseDelay);

        expect(
            await Promise.all(
                indexes.map(i => nftValueProvider.getNFTValueETH(i))
            )
        ).to.deep.equal(new Array(indexes.length).fill(floor));

        await nftValueProvider
            .connect(user)
            .withdrawTraitBoost(indexes.slice(1));

        expect(await jpgdToken.balanceOf(user.address)).to.equal(
            totalJpegAmount.sub(jpegAmounts[0])
        );
        expect(await jpgdToken.balanceOf(nftValueProvider.address)).to.equal(
            jpegAmounts[0]
        );
    });

    it("should allow queueing releases for LTV boost locks", async () => {
        const indexes = [100, 101, 102];
        const rateIncreases = [1000, 500, 250];

        const jpegAmounts = await Promise.all(
            rateIncreases.map(r =>
                nftValueProvider.calculateLTVBoostLock(jpgdTokenPrice, r)
            )
        );

        const totalJpegAmount = jpegAmounts.reduce((p, c) => p.add(c));

        await jpgdToken.mint(user.address, totalJpegAmount);
        await jpgdToken
            .connect(user)
            .approve(nftValueProvider.address, totalJpegAmount);

        await nftValueProvider
            .connect(user)
            .applyLTVBoost(indexes, rateIncreases);

        let creditLimitRates = await Promise.all(
            indexes.map(i =>
                nftValueProvider.getCreditLimitRate(user.address, i)
            )
        );
        let liquidationLimitRates = await Promise.all(
            indexes.map(i =>
                nftValueProvider.getLiquidationLimitRate(user.address, i)
            )
        );

        await expect(
            nftValueProvider.queueLTVBoostRelease(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        const startTimestamp = (await currentTimestamp()) + 1;
        await setNextTimestamp(startTimestamp);

        await nftValueProvider.connect(user).queueLTVBoostRelease(indexes);

        await expect(
            nftValueProvider.connect(user).queueLTVBoostRelease(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        expect(
            await Promise.all(
                indexes.map(i =>
                    nftValueProvider.ltvBoostPositions(i).then(l => l.unlockAt)
                )
            )
        ).to.deep.equal(
            new Array(indexes.length).fill(
                bn(startTimestamp + locksReleaseDelay)
            )
        );

        await expect(
            nftValueProvider.connect(user).withdrawLTVBoost(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        expect(
            await Promise.all(
                indexes.map(i =>
                    nftValueProvider.getCreditLimitRate(user.address, i)
                )
            )
        ).to.deep.equal(creditLimitRates);

        expect(
            await Promise.all(
                indexes.map(i =>
                    nftValueProvider.getLiquidationLimitRate(user.address, i)
                )
            )
        ).to.deep.equal(liquidationLimitRates);

        await expect(
            nftValueProvider.applyLTVBoost(indexes, rateIncreases)
        ).to.be.revertedWithCustomError(nftValueProvider, "LockExists");

        await timeTravel(locksReleaseDelay);

        expect(
            await Promise.all(
                indexes.map(i =>
                    nftValueProvider.getCreditLimitRate(user.address, i)
                )
            )
        ).to.deep.equal(
            new Array(indexes.length).fill(baseCreditLimitRate.map(n => bn(n)))
        );

        expect(
            await Promise.all(
                indexes.map(i =>
                    nftValueProvider.getLiquidationLimitRate(user.address, i)
                )
            )
        ).to.deep.equal(
            new Array(indexes.length).fill(
                baseLiquidationLimitRate.map(n => bn(n))
            )
        );

        await nftValueProvider.connect(user).withdrawLTVBoost(indexes.slice(1));

        expect(await jpgdToken.balanceOf(user.address)).to.equal(
            totalJpegAmount.sub(jpegAmounts[0])
        );
        expect(await jpgdToken.balanceOf(nftValueProvider.address)).to.equal(
            jpegAmounts[0]
        );
    });

    it("should allow cancelling queued releases for trait boost locks", async () => {
        const indexes = [100, 101, 102];

        await nftValueProvider.setNFTTypeMultiplier(apeHash, {
            numerator: 10,
            denominator: 1
        });
        await nftValueProvider.setNFTType(indexes, apeHash);

        const jpegAmounts = await Promise.all(
            indexes.map(() =>
                nftValueProvider.calculateTraitBoostLock(
                    apeHash,
                    jpgdTokenPrice
                )
            )
        );

        const totalJpegAmount = jpegAmounts.reduce((p, c) => p.add(c));

        await jpgdToken.mint(user.address, totalJpegAmount);
        await jpgdToken
            .connect(user)
            .approve(nftValueProvider.address, totalJpegAmount);

        await nftValueProvider.connect(user).applyTraitBoost(indexes);

        await expect(
            nftValueProvider.connect(user).cancelTraitBoostRelease(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        await nftValueProvider.connect(user).queueTraitBoostRelease(indexes);

        await nftValueProvider.connect(user).cancelTraitBoostRelease(indexes);

        await expect(
            nftValueProvider.connect(user).cancelTraitBoostRelease(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        expect(
            await Promise.all(
                indexes.map(i => nftValueProvider.traitBoostPositions(i))
            )
        ).to.deep.equal(jpegAmounts.map(a => [user.address, bn(0), a, true]));

        expect(
            await Promise.all(
                indexes.map(i => nftValueProvider.getNFTValueETH(i))
            )
        ).to.deep.equal(new Array(indexes.length).fill(floor.mul(10)));

        await expect(
            nftValueProvider.connect(user).withdrawTraitBoost(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        await nftValueProvider.connect(user).queueTraitBoostRelease(indexes);

        await timeTravel(locksReleaseDelay);

        await expect(
            nftValueProvider.connect(user).cancelTraitBoostRelease(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        expect(
            await Promise.all(
                indexes.map(i => nftValueProvider.getNFTValueETH(i))
            )
        ).to.deep.equal(new Array(indexes.length).fill(floor));

        await nftValueProvider
            .connect(user)
            .withdrawTraitBoost(indexes.slice(1));

        expect(await jpgdToken.balanceOf(user.address)).to.equal(
            totalJpegAmount.sub(jpegAmounts[0])
        );
        expect(await jpgdToken.balanceOf(nftValueProvider.address)).to.equal(
            jpegAmounts[0]
        );
    });

    it("should allow cancelling queued releases for ltv boost locks", async () => {
        const indexes = [100, 101, 102];
        const rateIncreases = [1000, 500, 250];

        const jpegAmounts = await Promise.all(
            rateIncreases.map(r =>
                nftValueProvider.calculateLTVBoostLock(jpgdTokenPrice, r)
            )
        );

        const totalJpegAmount = jpegAmounts.reduce((p, c) => p.add(c));

        await jpgdToken.mint(user.address, totalJpegAmount);
        await jpgdToken
            .connect(user)
            .approve(nftValueProvider.address, totalJpegAmount);

        await nftValueProvider
            .connect(user)
            .applyLTVBoost(indexes, rateIncreases);

        await expect(
            nftValueProvider.connect(user).cancelLTVBoostRelease(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        await nftValueProvider.connect(user).queueLTVBoostRelease(indexes);

        await nftValueProvider.connect(user).cancelLTVBoostRelease(indexes);

        expect(
            await Promise.all(
                indexes.map(i => nftValueProvider.ltvBoostPositions(i))
            )
        ).to.deep.equal(jpegAmounts.map(a => [user.address, bn(0), a, true]));

        expect(
            await Promise.all(
                indexes.map(i =>
                    nftValueProvider.getCreditLimitRate(user.address, i)
                )
            )
        ).to.deep.equal(
            rateIncreases.map(r => sumRates([r, 10_000], baseCreditLimitRate))
        );

        expect(
            await Promise.all(
                indexes.map(i =>
                    nftValueProvider.getLiquidationLimitRate(user.address, i)
                )
            )
        ).to.deep.equal(
            rateIncreases.map(r =>
                sumRates([r, 10_000], baseLiquidationLimitRate)
            )
        );

        await expect(
            nftValueProvider.connect(user).withdrawLTVBoost(indexes)
        ).to.be.revertedWithCustomError(nftValueProvider, "Unauthorized");

        await nftValueProvider.connect(user).queueLTVBoostRelease(indexes);

        await timeTravel(locksReleaseDelay);

        expect(
            await Promise.all(
                indexes.map(i =>
                    nftValueProvider.getCreditLimitRate(user.address, i)
                )
            )
        ).to.deep.equal(
            new Array(indexes.length).fill(baseCreditLimitRate.map(n => bn(n)))
        );

        expect(
            await Promise.all(
                indexes.map(i =>
                    nftValueProvider.getLiquidationLimitRate(user.address, i)
                )
            )
        ).to.deep.equal(
            new Array(indexes.length).fill(
                baseLiquidationLimitRate.map(n => bn(n))
            )
        );

        await nftValueProvider.connect(user).withdrawLTVBoost(indexes.slice(1));

        expect(await jpgdToken.balanceOf(user.address)).to.equal(
            totalJpegAmount.sub(jpegAmounts[0])
        );
        expect(await jpgdToken.balanceOf(nftValueProvider.address)).to.equal(
            jpegAmounts[0]
        );
    });

    it("should apply both LTV and cig boosts to the same JPGD", async () => {
        const indexes = [100, 101, 102];
        const rateIncreases = [2000, 1000, 500];

        const jpegAmounts = await Promise.all(
            rateIncreases.map(r =>
                nftValueProvider.calculateLTVBoostLock(jpgdTokenPrice, r)
            )
        );

        const totalJpegAmount = jpegAmounts.reduce((p, c) => p.add(c));
        await jpgdToken.mint(user.address, totalJpegAmount);
        await jpgdToken
            .connect(user)
            .approve(nftValueProvider.address, totalJpegAmount);

        await nftValueProvider
            .connect(user)
            .applyLTVBoost(indexes, rateIncreases);

        await cigStaking.unpause();

        await erc721.mint(user.address, 200);
        await erc721.connect(user).approve(cigStaking.address, 200);
        await cigStaking.connect(user).deposit(200);

        const creditLimitRates = await Promise.all(
            indexes.map(i =>
                nftValueProvider.getCreditLimitRate(user.address, i)
            )
        );

        const expectedCreditLimitRates = rateIncreases.map(r => {
            const rate = sumRates(
                [r, 10_000],
                baseCreditLimitRate,
                cigBoostRateIncrease
            );

            if (
                rate[0]
                    .mul(floor)
                    .div(rate[1])
                    .gt(floor.mul(ltvRateCap[0]).div(ltvRateCap[1]))
            )
                return [bn(ltvRateCap[0]), bn(ltvRateCap[1])];

            return rate;
        });

        expect(creditLimitRates).to.deep.equal(expectedCreditLimitRates);

        const liquidationLimitRates = await Promise.all(
            indexes.map(i =>
                nftValueProvider.getLiquidationLimitRate(user.address, i)
            )
        );

        const expectedLiquidationLimitRates = rateIncreases.map(r => {
            const rate = sumRates(
                [r, 10_000],
                baseLiquidationLimitRate,
                cigBoostRateIncrease
            );

            if (
                rate[0]
                    .mul(floor)
                    .div(rate[1])
                    .gt(
                        floor
                            .mul(liquidationRateCap[0])
                            .div(liquidationRateCap[1])
                    )
            )
                return [bn(liquidationRateCap[0]), bn(liquidationRateCap[1])];

            return rate;
        });

        expect(liquidationLimitRates).to.deep.equal(
            expectedLiquidationLimitRates
        );

        expect(await jpgdToken.balanceOf(user.address)).to.equal(0);
        expect(await jpgdToken.balanceOf(nftValueProvider.address)).to.equal(
            totalJpegAmount
        );
    });

    it("should delete locks and burn jpgdToken when calling onLiquidation", async () => {
        const nftIndex = 100;
        const rateIncrease = 2000;

        await nftValueProvider.setNFTTypeMultiplier(apeHash, {
            numerator: 10,
            denominator: 1
        });
        await nftValueProvider.setNFTType([nftIndex], apeHash);

        const jpegAmount = await nftValueProvider
            .calculateLTVBoostLock(jpgdTokenPrice, rateIncrease)
            .then(a =>
                nftValueProvider
                    .calculateTraitBoostLock(apeHash, jpgdTokenPrice)
                    .then(b => a.add(b))
            );

        await jpgdToken.mint(user.address, jpegAmount);
        await jpgdToken
            .connect(user)
            .approve(nftValueProvider.address, jpegAmount);

        await nftValueProvider
            .connect(user)
            .applyLTVBoost([nftIndex], [rateIncrease]);
        await nftValueProvider.connect(user).applyTraitBoost([nftIndex]);

        await expect(nftValueProvider.onLiquidation(nftIndex)).to.be.reverted;

        await nftValueProvider.grantRole(
            ethers.utils.solidityKeccak256(["string"], ["VAULT_ROLE"]),
            owner.address
        );
        await nftValueProvider.onLiquidation(nftIndex);

        expect(
            await jpgdToken.balanceOf(await nftValueProvider.BURN_ADDRESS())
        ).to.equal(jpegAmount);
        expect(
            await nftValueProvider.traitBoostPositions(nftIndex)
        ).to.have.property("owner", ZERO_ADDRESS);
        expect(
            await nftValueProvider.ltvBoostPositions(nftIndex)
        ).to.have.property("owner", ZERO_ADDRESS);
        expect(
            await nftValueProvider.ltvBoostRateIncreases(nftIndex)
        ).to.deep.equal([bn(0), bn(0)]);
    });

    it("should allow the owner to override floor price", async () => {
        await nftValueProvider.overrideFloor(units(10));
        expect(await nftValueProvider.getFloorETH()).to.equal(units(10));
        expect(await nftValueProvider.getNFTValueETH(0)).to.equal(units(10));
        await nftValueProvider.disableFloorOverride();
        expect(await nftValueProvider.getNFTValueETH(0)).to.equal(floor);
    });

    describe("Token migration", () => {
        let jpeg: JPEG;

        beforeEach(async () => {
            const JPEG = await ethers.getContractFactory("JPEG");

            jpeg = await JPEG.deploy(0);
            await jpeg.deployed();

            await nftValueProvider.setJPEG(jpeg.address);

            await jpeg.grantRole(minterRole, owner.address);
        });

        it("should send back jpeg tokens and transfer the correct amount of jpgd tokens when finalizing the upgrade", async () => {
            const jpegAmount = units(100);
            const jpgdAmount = jpegAmount.mul(jpgdSupply).div(jpegSupply);

            await jpeg.mint(nftValueProvider.address, jpegAmount);
            await jpgdToken.mint(owner.address, jpgdAmount);
            await jpgdToken.approve(nftValueProvider.address, jpgdAmount);

            await nftValueProvider.finalizeUpgrade();

            expect(await jpeg.balanceOf(owner.address)).to.equal(jpegAmount);
            expect(await jpeg.balanceOf(nftValueProvider.address)).to.equal(0);

            expect(await jpgdToken.balanceOf(owner.address)).to.equal(0);
            expect(
                await jpgdToken.balanceOf(nftValueProvider.address)
            ).to.equal(jpgdAmount);
        });

        it("should release jpgd tokens when releasing a legacy trait lock", async () => {
            const indexes = [100];

            await nftValueProvider.setNFTTypeMultiplier(apeHash, {
                numerator: 10,
                denominator: 1
            });
            await nftValueProvider.setNFTType(indexes, apeHash);

            const jpgdToLock = floor
                .mul(10)
                .sub(floor)
                .mul(traitBoostLockRate[0])
                .div(traitBoostLockRate[1])
                .mul(units(1))
                .div(jpgdTokenPrice);

            await jpgdToken.mint(user.address, jpgdToLock.mul(indexes.length));
            await jpgdToken
                .connect(user)
                .approve(
                    nftValueProvider.address,
                    jpgdToLock.mul(indexes.length)
                );

            await nftValueProvider.connect(user).applyTraitBoost(indexes);

            await nftValueProvider.setLegacyTraitLock(100, jpgdToLock);

            const expectedReleasedJpgd = jpgdToLock
                .mul(jpgdSupply)
                .div(jpegSupply);

            await jpgdToken.mint(
                nftValueProvider.address,
                expectedReleasedJpgd.sub(jpgdToLock)
            );

            await nftValueProvider.connect(user).queueTraitBoostRelease([100]);

            await timeTravel(locksReleaseDelay);

            await nftValueProvider.connect(user).withdrawTraitBoost(indexes);

            expect(await jpgdToken.balanceOf(user.address)).to.equal(
                expectedReleasedJpgd
            );
            expect(
                await jpgdToken.balanceOf(nftValueProvider.address)
            ).to.equal(0);
        });

        it("should release jpgd tokens and lock jpgd tokens when overriding a released legacy trait lock", async () => {
            const indexes = [100];

            await nftValueProvider.setNFTTypeMultiplier(apeHash, {
                numerator: 10,
                denominator: 1
            });
            await nftValueProvider.setNFTType(indexes, apeHash);

            const jpgdToLock = floor
                .mul(10)
                .sub(floor)
                .mul(traitBoostLockRate[0])
                .div(traitBoostLockRate[1])
                .mul(units(1))
                .div(jpgdTokenPrice);

            await jpgdToken.mint(user.address, jpgdToLock.mul(indexes.length));
            await jpgdToken
                .connect(user)
                .approve(
                    nftValueProvider.address,
                    jpgdToLock.mul(indexes.length)
                );

            await nftValueProvider.connect(user).applyTraitBoost(indexes);

            await nftValueProvider.setLegacyTraitLock(100, jpgdToLock);

            const expectedReleasedJpgd = jpgdToLock
                .mul(jpgdSupply)
                .div(jpegSupply);

            await jpgdToken.mint(
                nftValueProvider.address,
                expectedReleasedJpgd.sub(jpgdToLock)
            );

            await jpgdToken.mint(user.address, jpgdToLock.mul(indexes.length));

            await jpgdToken
                .connect(user)
                .approve(
                    nftValueProvider.address,
                    jpgdToLock.mul(indexes.length)
                );

            await expect(
                nftValueProvider.connect(user).applyTraitBoost(indexes)
            ).to.be.revertedWithCustomError(nftValueProvider, "LockExists");

            await nftValueProvider.connect(user).queueTraitBoostRelease([100]);

            await timeTravel(locksReleaseDelay);

            await nftValueProvider.connect(user).applyTraitBoost(indexes);

            expect(await jpgdToken.balanceOf(user.address)).to.equal(
                expectedReleasedJpgd.mul(indexes.length)
            );
            expect(
                await jpgdToken.balanceOf(nftValueProvider.address)
            ).to.equal(jpgdToLock.mul(indexes.length));

            const traitBoost = await nftValueProvider.traitBoostPositions(100);

            expect(traitBoost.isNewToken).to.be.true;
            expect(traitBoost.lockedValue).to.equal(jpgdToLock);
        });

        it("should release jpgd tokens when releasing a legacy ltv lock", async () => {
            const index = 100;
            const rateIncrease = 500;

            const jpgdToLock = await nftValueProvider.calculateLTVBoostLock(
                jpgdTokenPrice,
                rateIncrease
            );

            await jpgdToken.mint(user.address, jpgdToLock);
            await jpgdToken
                .connect(user)
                .approve(nftValueProvider.address, jpgdToLock);

            await nftValueProvider
                .connect(user)
                .applyLTVBoost([index], [rateIncrease]);

            await nftValueProvider.setLegacyLTVLock(100, jpgdToLock);
            const expectedReleasedJpgd = jpgdToLock
                .mul(jpgdSupply)
                .div(jpegSupply);

            await jpgdToken.mint(
                nftValueProvider.address,
                expectedReleasedJpgd.sub(jpgdToLock)
            );

            await nftValueProvider.connect(user).queueLTVBoostRelease([100]);

            await timeTravel(locksReleaseDelay);

            await nftValueProvider.connect(user).withdrawLTVBoost([index]);

            expect(await jpgdToken.balanceOf(user.address)).to.equal(
                expectedReleasedJpgd
            );
            expect(
                await jpgdToken.balanceOf(nftValueProvider.address)
            ).to.equal(0);
        });

        it("should release jpgd tokens and lock jpgd tokens when overriding a legacy ltv lock", async () => {
            const index = 100;
            const rateIncrease = 500;

            const jpgdToLock = await nftValueProvider.calculateLTVBoostLock(
                jpgdTokenPrice,
                rateIncrease
            );

            await jpgdToken.mint(user.address, jpgdToLock);
            await jpgdToken
                .connect(user)
                .approve(nftValueProvider.address, jpgdToLock);

            await nftValueProvider
                .connect(user)
                .applyLTVBoost([index], [rateIncrease]);

            await nftValueProvider.setLegacyLTVLock(100, jpgdToLock);
            const expectedReleasedJpgd = jpgdToLock
                .mul(jpgdSupply)
                .div(jpegSupply);

            await jpgdToken.mint(
                nftValueProvider.address,
                expectedReleasedJpgd.sub(jpgdToLock)
            );

            await jpgdToken
                .connect(user)
                .approve(nftValueProvider.address, jpgdToLock);

            await expect(
                nftValueProvider
                    .connect(user)
                    .applyLTVBoost([index], [rateIncrease])
            ).to.be.revertedWithCustomError(nftValueProvider, "LockExists");

            await jpgdToken.mint(user.address, jpgdToLock.mul(2));
            await jpgdToken
                .connect(user)
                .approve(nftValueProvider.address, jpgdToLock.mul(2));

            await nftValueProvider
                .connect(user)
                .applyLTVBoost([index], [rateIncrease * 2]);

            expect(await jpgdToken.balanceOf(user.address)).to.equal(
                expectedReleasedJpgd
            );
            expect(
                await jpgdToken.balanceOf(nftValueProvider.address)
            ).to.equal(jpgdToLock.mul(2));

            const traitBoost = await nftValueProvider.ltvBoostPositions(100);

            expect(traitBoost.isNewToken).to.be.true;
            expect(traitBoost.lockedValue).to.equal(jpgdToLock.mul(2));
        });
    });
});
