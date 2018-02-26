/* global artifacts, contract, it, before, assert, web3 */
/* eslint-disable prefer-reflect, no-loop-func */

let constants = require('./helpers/FormulaConstants.js');
let TestBancorFormula = artifacts.require('./helpers/TestBancorFormula.sol');
let ERROR_MESSAGE = 'VM Exception while processing transaction: invalid opcode';

contract('BancorFormula', () => {
    let formula;
    before(async () => {
        formula = await TestBancorFormula.new();
    });

    let ILLEGAL_VALUE = web3.toBigNumber(2).toPower(256);
    let MAX_NUMERATOR = web3.toBigNumber(2).toPower(256 - constants.MAX_PRECISION).minus(1);
    let MIN_DENOMINATOR = web3.toBigNumber(1);
    let MAX_EXPONENT = 1000000;

    for (let percent = 1; percent <= 100; percent++) {
        let baseN = MAX_NUMERATOR;
        let baseD = MAX_NUMERATOR.minus(1);
        let expN  = MAX_EXPONENT * percent / 100;
        let expD  = MAX_EXPONENT;
        let test  = `Function power(0x${baseN.toString(16)}, 0x${baseD.toString(16)}, ${expN}, ${expD})`;

        it(`${test}:`, async () => {
            try {
                let retVal = await formula.powerTest(baseN, baseD, expN, expD);
                assert(percent <= 100, `${test} passed when it should have failed`);
            }
            catch (error) {
                assert(percent >= 101 && error.message == ERROR_MESSAGE, error.message);
            }
        });
    }

    for (let percent = 1; percent <= 100; percent++) {
        let baseN = MAX_NUMERATOR;
        let baseD = MAX_NUMERATOR.minus(1);
        let expN  = MAX_EXPONENT;
        let expD  = MAX_EXPONENT * percent / 100;
        let test  = `Function power(0x${baseN.toString(16)}, 0x${baseD.toString(16)}, ${expN}, ${expD})`;

        it(`${test}:`, async () => {
            try {
                let retVal = await formula.powerTest(baseN, baseD, expN, expD);
                assert(percent <= 100, `${test} passed when it should have failed`);
            }
            catch (error) {
                assert(percent >= 101 && error.message == ERROR_MESSAGE, error.message);
            }
        });
    }

    for (let percent = 1; percent <= 100; percent++) {
        let baseN = MAX_NUMERATOR;
        let baseD = MIN_DENOMINATOR;
        let expN  = MAX_EXPONENT * percent / 100;
        let expD  = MAX_EXPONENT;
        let test  = `Function power(0x${baseN.toString(16)}, 0x${baseD.toString(16)}, ${expN}, ${expD})`;

        it(`${test}:`, async () => {
            try {
                let retVal = await formula.powerTest(baseN, baseD, expN, expD);
                assert(percent <= 63, `${test} passed when it should have failed`);
            }
            catch (error) {
                assert(percent >= 64 && error.message == ERROR_MESSAGE, error.message);
            }
        });
    }

    for (let percent = 1; percent <= 100; percent++) {
        let baseN = MAX_NUMERATOR;
        let baseD = MIN_DENOMINATOR;
        let expN  = MAX_EXPONENT;
        let expD  = MAX_EXPONENT * percent / 100;
        let test  = `Function power(0x${baseN.toString(16)}, 0x${baseD.toString(16)}, ${expN}, ${expD})`;

        it(`${test}:`, async () => {
            try {
                let retVal = await formula.powerTest(baseN, baseD, expN, expD);
                assert(percent <= 0, `${test} passed when it should have failed`);
            }
            catch (error) {
                assert(percent >= 1 && error.message == ERROR_MESSAGE, error.message);
            }
        });
    }

    let cases = [
        {'numerator' : MAX_NUMERATOR        , 'denominator' : MAX_NUMERATOR.minus(1), 'assertion' : true },
        {'numerator' : MAX_NUMERATOR        , 'denominator' : MIN_DENOMINATOR       , 'assertion' : true },
        {'numerator' : MAX_NUMERATOR.plus(1), 'denominator' : MIN_DENOMINATOR       , 'assertion' : false},
    ];

    for (let index = 0; index < cases.length; index++) {
        let numerator   = cases[index]['numerator'  ];
        let denominator = cases[index]['denominator'];
        let assertion   = cases[index]['assertion'  ];
        let test        = `Function ln(0x${numerator.toString(16)}, 0x${denominator.toString(16)})`;

        it(`${test}:`, async () => {
            try {
                let retVal = await formula.lnTest(numerator, denominator);
                assert(retVal.times(MAX_EXPONENT).lessThan(ILLEGAL_VALUE), `${test}: output is too large`);
                assert(assertion, `${test} passed when it should have failed`);
            }
            catch (error) {
                assert(!assertion && error.message == ERROR_MESSAGE, error.message);
            }
        });
    }

    for (let precision = constants.MIN_PRECISION; precision <= constants.MAX_PRECISION; precision++) {
        let maxExp = web3.toBigNumber(constants.maxExpArray[precision]);
        let shlVal = web3.toBigNumber(2).toPower(constants.MAX_PRECISION - precision);
        let tuples = [
            {'input' : maxExp.plus(0).times(shlVal).minus(1), 'output' : web3.toBigNumber(precision-0)},
            {'input' : maxExp.plus(0).times(shlVal).minus(0), 'output' : web3.toBigNumber(precision-0)},
            {'input' : maxExp.plus(1).times(shlVal).minus(1), 'output' : web3.toBigNumber(precision-0)},
            {'input' : maxExp.plus(1).times(shlVal).minus(0), 'output' : web3.toBigNumber(precision-1)},
        ];

        for (let index = 0; index < tuples.length; index++) {
            let input  = tuples[index]['input' ];
            let output = tuples[index]['output'];
            let test   = `Function findPositionInMaxExpArray(0x${input.toString(16)})`;

            it(`${test}:`, async () => {
                try {
                    let retVal = await formula.findPositionInMaxExpArrayTest(input);
                    assert(retVal.equals(output), `${test}: output should be ${output.toString(10)} but it is ${retVal.toString(10)}`);
                    assert(precision > constants.MIN_PRECISION || !output.lessThan(web3.toBigNumber(precision)), `${test} passed when it should have failed`);
                }
                catch (error) {
                    assert(precision == constants.MIN_PRECISION && output.lessThan(web3.toBigNumber(precision)) && error.message == ERROR_MESSAGE, error.message);
                }
            });
        }
    }

    for (let precision = constants.MIN_PRECISION; precision <= constants.MAX_PRECISION; precision++) {
        let maxExp = web3.toBigNumber(constants.maxExpArray[precision]);
        let maxVal = web3.toBigNumber(constants.maxValArray[precision]);
        let errExp = maxExp.plus(1);
        let test1  = `Function fixedExp(0x${maxExp.toString(16)}, ${precision})`;
        let test2  = `Function fixedExp(0x${errExp.toString(16)}, ${precision})`;

        it(`${test1}:`, async () => {
            let retVal = await formula.fixedExpTest(maxExp, precision);
            assert(retVal.equals(maxVal), `${test1}: output is wrong`);
        });

        it(`${test2}:`, async () => {
            let retVal = await formula.fixedExpTest(errExp, precision);
            assert(retVal.lessThan(maxVal), `${test2}:  output indicates that maxExpArray[${precision}] is wrong`);
        });
    }

    for (let precision = constants.MIN_PRECISION; precision <= constants.MAX_PRECISION; precision++) {
        let minExp = web3.toBigNumber(constants.maxExpArray[precision-1]).plus(1);
        let minVal = web3.toBigNumber(2).toPower(precision);
        let test   = `Function fixedExp(0x${minExp.toString(16)}, ${precision})`;

        it(`${test}:`, async () => {
            let retVal = await formula.fixedExpTest(minExp, precision);
            assert(retVal.greaterThanOrEqualTo(minVal), `${test}: output is too small`);
        });
    }

    for (let n = 1; n <= 255; n++) {
        let tuples = [
            {'input' : web3.toBigNumber(2).toPower(n)           , 'output' : web3.toBigNumber(n)},
            {'input' : web3.toBigNumber(2).toPower(n).plus(1)   , 'output' : web3.toBigNumber(n)},
            {'input' : web3.toBigNumber(2).toPower(n+1).minus(1), 'output' : web3.toBigNumber(n)},
        ];

        for (let index = 0; index < tuples.length; index++) {
            let input  = tuples[index]['input' ];
            let output = tuples[index]['output'];
            let test   = `Function floorLog2(0x${input.toString(16)})`;

            it(`${test}:`, async () => {
                let retVal = await formula.floorLog2Test(input);
                assert(retVal.equals(output), `${test}: output should be ${output.toString(10)} but it is ${retVal.toString(10)}`);
            });
        }
    }

    describe(`Optimized Code:`, async () => {
        let LOG_MIN = 1;
        let EXP_MIN = 0;
        let LOG_MAX = Math.exp(1);
        let EXP_MAX = Math.pow(2,4);

        web3.BigNumber.config({ERRORS:false});

        let FIXED_ONE;
        before(async () => {
            FIXED_ONE = await formula.FIXED_ONE();
        });

        describe(`function log:`, async () => {
            for (let percent = 0; percent <= 100; percent++) {
                let x = percent / 100 * (LOG_MAX - LOG_MIN) + LOG_MIN;
                let cond = percent < 100;
                let test = `function log(${x})`;

                it(`${test} should ${cond ? "pass" : "fail"}`, async () => {
                    try {
                        await formula.logTest(FIXED_ONE.times(x).truncated());
                        assert(cond, `${test} passed when it should have failed`);
                    }
                    catch (error) {
                        assert(!cond && error.message == ERROR_MESSAGE, error.message);
                    }
                });
            }
        });

        describe(`function exp:`, async () => {
            for (let percent = 0; percent <= 100; percent++) {
                let x = percent / 100 * (EXP_MAX - EXP_MIN) + EXP_MIN;
                let cond = percent < 100;
                let test = `function exp(${x})`;

                it(`${test} should ${cond ? "pass" : "fail"}`, async () => {
                    try {
                        await formula.expTest(FIXED_ONE.times(x).truncated());
                        assert(cond, `${test} passed when it should have failed`);
                    }
                    catch (error) {
                        assert(!cond && error.message == ERROR_MESSAGE, error.message);
                    }
                });
            }
        });
    });
});
