from decimal import Decimal
from decimal import getcontext


getcontext().prec = 80 # 78 digits for a maximum of 2^256-1, and 2 more digits for after the decimal point


def calculatePurchaseReturn(supply, balance, weight, amount):
    supply, balance, weight, amount = [Decimal(value) for value in vars().values()]
    return supply*((1+amount/balance)**(weight/1000000)-1)


def calculateSaleReturn(supply, balance, weight, amount):
    supply, balance, weight, amount = [Decimal(value) for value in vars().values()]
    return balance*(1-(1-amount/supply)**(1000000/weight))


def calculateCrossReserveReturn(balance1, weight1, balance2, weight2, amount):
    balance1, weight1, balance2, weight2, amount = [Decimal(value) for value in vars().values()]
    return balance2*(1-(balance1/(balance1+amount))**(weight1/weight2))


def calculateFundCost(supply, balance, weights, amount):
    supply, balance, weights, amount = [Decimal(value) for value in vars().values()]
    return balance*(((supply+amount)/supply)**(1000000/weights)-1)


def calculateLiquidateReturn(supply, balance, weights, amount):
    supply, balance, weights, amount = [Decimal(value) for value in vars().values()]
    return balance*(1-((supply-amount)/supply)**(1000000/weights))


def power(baseN, baseD, expN, expD, precision):
    baseN, baseD, expN, expD, precision = [Decimal(value) for value in vars().values()]
    return (baseN/baseD)**(expN/expD)*2**precision
