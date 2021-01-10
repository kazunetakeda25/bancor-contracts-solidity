const { accounts, defaultSender, contract } = require('@openzeppelin/test-environment');
const { expectRevert } = require('@openzeppelin/test-helpers');
const { roles } = require('./helpers/Constants');
const { expect } = require('../../chai-local');

const LiquidityProtectionStats = contract.fromArtifact('LiquidityProtectionStats');

describe('LiquidityProtectionStats', () => {
    let liquidityProtectionStats;

    const owner = accounts[1];
    const nonOwner = accounts[2];
    const provider = accounts[3];
    const poolToken = accounts[4];
    const reserveToken = accounts[5];

    beforeEach(async () => {
        liquidityProtectionStats = await LiquidityProtectionStats.new();
        await liquidityProtectionStats.grantRole(roles.ROLE_OWNER, owner, { from: defaultSender });
    });

    describe('general verification', () => {
        it('should revert when a non owner attempts to increase total amounts', async () => {
            await expectRevert(
                liquidityProtectionStats.increaseTotalAmounts(provider, poolToken, reserveToken, 1, 2, { from: nonOwner }),
                'ERR_ACCESS_DENIED'
            );
            expect(await liquidityProtectionStats.totalPoolAmount(poolToken)).to.be.bignumber.equal('0');
            expect(await liquidityProtectionStats.totalReserveAmount(poolToken, reserveToken)).to.be.bignumber.equal('0');
            expect(await liquidityProtectionStats.totalProviderAmount(poolToken, reserveToken, provider)).to.be.bignumber.equal('0');
        });

        it('should revert when a non owner attempts to decrease total amounts', async () => {
            await liquidityProtectionStats.increaseTotalAmounts(provider, poolToken, reserveToken, 1, 2, { from: owner });
            await expectRevert(
                liquidityProtectionStats.decreaseTotalAmounts(provider, poolToken, reserveToken, 1, 2, { from: nonOwner }),
                'ERR_ACCESS_DENIED'
            );
            expect(await liquidityProtectionStats.totalPoolAmount(poolToken)).to.be.bignumber.equal('1');
            expect(await liquidityProtectionStats.totalReserveAmount(poolToken, reserveToken)).to.be.bignumber.equal('2');
            expect(await liquidityProtectionStats.totalProviderAmount(poolToken, reserveToken, provider)).to.be.bignumber.equal('2');
        });

        it('should succeed when the owner attempts to increase total amounts', async () => {
            expect(await liquidityProtectionStats.totalPoolAmount(poolToken)).to.be.bignumber.equal('0');
            expect(await liquidityProtectionStats.totalReserveAmount(poolToken, reserveToken)).to.be.bignumber.equal('0');
            expect(await liquidityProtectionStats.totalProviderAmount(poolToken, reserveToken, provider)).to.be.bignumber.equal('0');
            const response = await liquidityProtectionStats.increaseTotalAmounts(provider, poolToken, reserveToken, 1, 2, { from: owner });
            expect(await liquidityProtectionStats.totalPoolAmount(poolToken)).to.be.bignumber.equal('1');
            expect(await liquidityProtectionStats.totalReserveAmount(poolToken, reserveToken)).to.be.bignumber.equal('2');
            expect(await liquidityProtectionStats.totalProviderAmount(poolToken, reserveToken, provider)).to.be.bignumber.equal('2');
        });

        it('should succeed when the owner attempts to decrease total amounts', async () => {
            await liquidityProtectionStats.increaseTotalAmounts(provider, poolToken, reserveToken, 1, 2, { from: owner });
            expect(await liquidityProtectionStats.totalPoolAmount(poolToken)).to.be.bignumber.equal('1');
            expect(await liquidityProtectionStats.totalReserveAmount(poolToken, reserveToken)).to.be.bignumber.equal('2');
            expect(await liquidityProtectionStats.totalProviderAmount(poolToken, reserveToken, provider)).to.be.bignumber.equal('2');
            const response = await liquidityProtectionStats.decreaseTotalAmounts(provider, poolToken, reserveToken, 1, 2, { from: owner });
            expect(await liquidityProtectionStats.totalPoolAmount(poolToken)).to.be.bignumber.equal('0');
            expect(await liquidityProtectionStats.totalReserveAmount(poolToken, reserveToken)).to.be.bignumber.equal('0');
            expect(await liquidityProtectionStats.totalProviderAmount(poolToken, reserveToken, provider)).to.be.bignumber.equal('0');
        });
    });
});
