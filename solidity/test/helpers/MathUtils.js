module.exports = {
    floorSqrt,
    ceilSqrt,
    reducedRatio,
    normalizedRatio,
    accurateRatio,
    roundDiv,
    compareRatios,
    weightedAverageForIntegers,
    weightedAverageForFractions
};

const Decimal = require('decimal.js');

const MAX_UINT256 = Decimal(2).pow(256).sub(1);

function floorSqrt(n) {
    return Decimal(n.toString()).sqrt().floor().toFixed();
}

function ceilSqrt(n) {
    return Decimal(n.toString()).sqrt().ceil().toFixed();
}

function reducedRatio(a, b, max) {
    [a, b, max] = [...arguments].map((x) => Decimal(x));
    if (a.gt(max) || b.gt(max)) {
        return normalizedRatio(a, b, max);
    }
    return [a, b].map(x => x.toFixed());
}

function normalizedRatio(a, b, scale) {
    [a, b, scale] = [...arguments].map((x) => Decimal(x));
    if (a.lte(b)) {
        return accurateRatio(a, b, scale);
    }
    return accurateRatio(b, a, scale).slice().reverse();
}

function accurateRatio(a, b, scale) {
    [a, b, scale] = [...arguments].map((x) => Decimal(x));
    return [a, b].map(x => x.div(a.add(b)).mul(scale).toFixed());
}

function roundDiv(a, b) {
    [a, b] = [...arguments].map((x) => Decimal(x));
    return a.div(b).toFixed(0, Decimal.ROUND_HALF_UP);
}

function compareRatios(a, b, c, d) {
    [a, b, c, d] = [...arguments].map((x) => Decimal(x));
    return a.div(b).cmp(c.div(d));
}

function weightedAverageForIntegers(a, b, p, q) {
    [a, b, p, q] = [...arguments].map((x) => Decimal(x));
    return a.add(b.sub(a).mul(p).div(q)).toFixed();
}

function weightedAverageForFractions(a, b, c, d, p, q) {
    [a, b, c, d, p, q] = [...arguments].map((x) => Decimal(x));
    return a.div(b).add(c.div(d).sub(a.div(b)).mul(p).div(q)).toFixed();
}
