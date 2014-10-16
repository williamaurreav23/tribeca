/// <reference path="typings/tsd.d.ts" />
/// <reference path="utils.ts" />

var util = require("util");

class MarketSide {
    constructor(public price: number, public size: number) { }

    public equals(other : MarketSide) {
        return this.price == other.price && this.size == other.size;
    }
}

class MarketUpdate {
    constructor(
        public bid : MarketSide,
        public ask : MarketSide,
        public time : Date) { }

    public equals(other : MarketUpdate) {
        return this.ask.equals(other.ask) && this.bid.equals(other.bid);
    }
}

enum ConnectivityStatus { Connected, Disconnected }
enum Exchange { Coinsetter, HitBtc, OkCoin, AtlasAts }
enum Side { Bid, Ask }
enum OrderType { Limit, Market }
enum TimeInForce { IOC, FOK, GTC }
enum OrderStatus { New, PendingCancel, Working, PartialFill, Filled, Cancelled, Rejected, Other, CancelRejected }
enum Liquidity { Make, Take }

class MarketBook {
    constructor(public top: MarketUpdate, public second: MarketUpdate, public exchangeName: Exchange) { }
}

interface Order {
    side : Side;
    quantity : number;
    type : OrderType;
    price : number;
    timeInForce : TimeInForce;
}

class SubmitNewOrder implements Order {
    constructor(
        public side : Side,
        public quantity : number,
        public type : OrderType,
        public price : number,
        public timeInForce : TimeInForce,
        public exchange : Exchange) {}

    public toString = () => {
        return util.format("side=%s; quantity=%d; type=%d; price=%d, tif=%s; exch=%s", Side[this.side], this.quantity,
            OrderType[this.type], this.price, TimeInForce[this.timeInForce], Exchange[this.exchange]);
    };
}

class CancelReplaceOrder implements Order {
    constructor(
        public origOrderId : string,
        public side : Side,
        public quantity : number,
        public type : OrderType,
        public price : number,
        public timeInForce : TimeInForce,
        public exchange : Exchange) {}

    public toString = () => {
        return util.format("orig=%s; side=%s; quantity=%d; type=%d; price=%d, tif=%s; exch=%s", this.origOrderId,
            Side[this.side], this.quantity, OrderType[this.type], this.price, TimeInForce[this.timeInForce],
            Exchange[this.exchange]);
    };
}

class OrderCancel {
    constructor(
        public origOrderId : string,
        public exchange : Exchange) {}

    public toString = () => {
        return util.format("orig=%s; exch=%s", this.origOrderId, Exchange[this.exchange]);
    };
}

class BrokeredOrder implements Order {
    constructor(
        public orderId : string,
        public side : Side,
        public quantity : number,
        public type : OrderType,
        public price : number,
        public timeInForce : TimeInForce,
        public exchange : Exchange) {}

    public toString = () => {
        return util.format("orderId=%s; side=%s; quantity=%d; type=%d; price=%d, tif=%s; exch=%s", this.orderId,
            Side[this.side], this.quantity, OrderType[this.type], this.price,
            TimeInForce[this.timeInForce], Exchange[this.exchange]);
    };
}

class BrokeredReplace implements Order {
    constructor(
        public orderId : string,
        public origOrderId : string,
        public side : Side,
        public quantity : number,
        public type : OrderType,
        public price : number,
        public timeInForce : TimeInForce,
        public exchange : Exchange,
        public exchangeId : string) {}

    public toString = () => {
        return util.format("origCliId=%s; origExchId=%s; orderId=%s; side=%s; quantity=%d; type=%d; price=%d, tif=%s; exch=%s",
            this.origOrderId, this.exchangeId, this.orderId,  Side[this.side], this.quantity,
            OrderType[this.type], this.price, TimeInForce[this.timeInForce], Exchange[this.exchange]);
    };
}

class BrokeredCancel {
    constructor(
        public clientOrderId : string,
        public requestId : string,
        public side : Side,
        public exchangeId : string) {}

    public toString = () => {
        return util.format("reqId=%s; origCliId=%s; origExchId=%s, side=%s",
            this.requestId, this.clientOrderId, this.exchangeId, Side[this.side]);
    };
}

interface GatewayOrderStatusReport {
    orderId : string;
    exchangeId? : string;
    orderStatus : OrderStatus;
    rejectMessage? : string;
    time : Date;
    lastQuantity? : number;
    lastPrice? : number;
    leavesQuantity? : number;
    cumQuantity? : number;
    averagePrice? : number;
    liquidity? : Liquidity;
}

interface OrderStatusReport extends Order, GatewayOrderStatusReport {
    exchange : Exchange;
    message? : string;
}

interface IGateway {
    MarketData : Evt<MarketBook>;
    ConnectChanged : Evt<ConnectivityStatus>;
    name() : string;
    makeFee() : number;
    takeFee() : number;
    exchange() : Exchange;
    sendOrder(order : BrokeredOrder);
    cancelOrder(cancel : BrokeredCancel);
    replaceOrder(replace : BrokeredReplace);
    OrderUpdate : Evt<GatewayOrderStatusReport>;
}

interface IBroker {
    MarketData : Evt<MarketBook>;
    name() : string;
    currentBook() : MarketBook;
    makeFee() : number;
    takeFee() : number;
    exchange() : Exchange;
    sendOrder(order : Order);
    cancelOrder(cancel : OrderCancel);
    replaceOrder(replace : CancelReplaceOrder);
    OrderUpdate : Evt<OrderStatusReport>;
    allOrders() : Array<OrderStatusReport>;
}