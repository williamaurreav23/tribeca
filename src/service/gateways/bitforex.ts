/// <reference path="../utils.ts" />
/// <reference path="../../common/models.ts" />
/// <reference path="nullgw.ts" />
///<reference path="../interfaces.ts"/>

import ws = require('ws');
import Q = require("q");
import colors = require('colors');
import crypto = require("crypto");
import request = require("request");
import url = require("url");
import querystring = require("querystring");
import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../common/models");
import Utils = require("../utils");
import util = require("util");
import Interfaces = require("../interfaces");
import moment = require("moment");
import _ = require("lodash");
import log from "../logging";
var shortId = require("shortid");

var API_KEY = '';
var API_SECRET = '';

var generateMessage = (url, params) => {
    let message = url + '?';
    var keys = Object.keys(params).sort()
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        message = message + key + '=' + params[key] + '&';
    }
    return message.substring(0, message.length - 1);
}

var generateSign = (url, params) => {
    var message = generateMessage(url, params);
    return crypto.createHmac('SHA256', API_SECRET).update(message).digest('hex').toLowerCase();
}

var generateSignedUrl = (url, params) => {
    var message = generateMessage(url, params);
    var signature = generateSign(url, params);
    return message + '&signData=' + signature;
}

var bitforexPlaceOrder = (order) => {
    var PLACE_ORDER_URL = '/api/v1/trade/placeOrder';
    var params = Object.assign({}, order);
    params.accessKey = API_KEY;
    params.nonce = new Date().getTime();
    params.signData = generateSign(PLACE_ORDER_URL, params);
    return {
        actionUrl: PLACE_ORDER_URL,
        msg: params
    };
}

var bitforexCancelOrder = (order) => {
    var PLACE_ORDER_URL = '/api/v1/trade/cancelOrder';
    var params = Object.assign({}, order);
    params.accessKey = API_KEY;
    params.nonce = new Date().getTime();
    params.signData = generateSign(PLACE_ORDER_URL, params);
    return {
        actionUrl: PLACE_ORDER_URL,
        msg: params
    };
}

var bitforexGetAllAssets = () => {
    var PLACE_ORDER_URL = '/api/v1/fund/allAccount';
    var params:any = {};
    params.accessKey = API_KEY;
    params.nonce = new Date().getTime();
    params.signData = generateSign(PLACE_ORDER_URL, params);
    return {
        actionUrl: PLACE_ORDER_URL,
        msg: params
    };
}

interface BitforexMessageIncomingMessage {
    param : any;
    success?: boolean;
    data : any;
    event? : string;
}

interface BitforexDepthObject {
    price : number;
    amount : number;
}

interface BitforexDepthMessage {
    asks : Array<BitforexDepthObject>;
    bids : Array<BitforexDepthObject>;
}

interface OrderAck {
    result: string; // "true" or "false"
    order_id: number;
}

interface SignedMessage {
    signData?: string;
}

interface Order extends SignedMessage {
    symbol: string;
    tradeType: number;
    price: number;
    amount: number;
}

interface Cancel extends SignedMessage {
    orderId: string;
    symbol: string;
}
/* DIRECTION 
    1: BUY
    2: SELL
*/
interface BitforexTradeRecord {
    amount: number;
    direction: number;
    price: number;
    tid: string;
    time: number;
}

interface SubscriptionRequest extends SignedMessage { }

// CHANNEL is bitforex websocket event
//Inigo V1
class BitforexWebsocket {
	send = <T>(msg: any, cb?: () => void) => {
    
        console.log(colors.blue('SOCKET SEND'));
        console.log(colors.blue(JSON.stringify(msg)));
        
        this._ws.send(JSON.stringify(msg), (e: Error) => {
            if (!e && cb) cb();
        });
    }
    
    setHandler = <T>(channel : string, handler: (newMsg : Models.Timestamped<T>) => void) => {
        this._handlers[channel] = handler;
    }

    private onMessage = (raw : string) => {
        console.log(colors.blue('SOCKET MESSAGE'));
        console.log(colors.blue(raw));
        var t = Utils.date();
        try {
            if (raw.indexOf('pong_p') !== -1) {
                return;
            }
            var msg : BitforexMessageIncomingMessage = JSON.parse(raw);

            if (msg.event !== 'depth10' && msg.event !== 'trade') {
                return;
            }

            if (typeof msg.success !== "undefined") {
                if (msg.success !== true)
                    this._log.warn("Unsuccessful message", msg);
                else
                    this._log.info("Successfully connected to %s", msg.event);
            }

            var handler = this._handlers[msg.event];

            if (typeof handler === "undefined") {
                this._log.warn("Got message on unknown topic", msg);
                return;
            }

            handler(new Models.Timestamped(msg.data, t));
        }
        catch (e) {
            this._log.error(e, "Error parsing msg %o", raw);
            throw e;
        }
    };

    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    private _serializedHeartbeat = 'ping_p';
    private _log = log("tribeca:gateway:BitforexWebsocket");
    private _handlers : { [channel : string] : (newMsg : Models.Timestamped<any>) => void} = {};
    private _ws : ws;
    public pingInterval: any;
    constructor(config : Config.IConfigProvider) {
        this._ws = new ws(config.GetString("BitforexWsUrl"));
        this._ws.on("open", () => {
            console.log(colors.blue('SOCKET OPENED'));
            this.pingInterval = setInterval(() => {
                console.log(colors.blue('SOCKET PING'));
                this._ws.send(this._serializedHeartbeat);
            }, 10000);
            this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected)
        });
        this._ws.on("message", this.onMessage);
        this._ws.on("close", () => this.ConnectChanged.trigger(Models.ConnectivityStatus.Disconnected));
    }
}

// Inigo V1
class BitforexMarketDataGateway implements Interfaces.IMarketDataGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
    private onTrade = (trades : Models.Timestamped<Array<BitforexTradeRecord>>) => {
        console.log(colors.blue('DEPTH TRADE RECEIVED'));
        console.log(colors.blue(JSON.stringify(trades.data)));
        // [tid, price, amount, time, type]
        _.forEach(trades.data, (trade : BitforexTradeRecord) => {
            var px = trade.price;
            var amt = trade.amount;
            var side = trade.direction === 2 ? Models.Side.Ask : Models.Side.Bid;
            var mt = new Models.GatewayMarketTrade(px, amt, trades.time, trades.data.length > 0, side);
            this.MarketTrade.trigger(mt);
        });
    };

    MarketData = new Utils.Evt<Models.Market>();
    
    private static GetLevel = (n: BitforexDepthObject) : Models.MarketSide => 
        new Models.MarketSide(n.price, n.amount);
        
    private readonly Depth: number = 25;
    private onDepth = (depth : Models.Timestamped<BitforexDepthMessage>) => {
        console.log(colors.blue('DEPTH DATA RECEIVED'));
        console.log(colors.blue(JSON.stringify(depth.data)));
        var msg = depth.data;

        var bids = _(msg.bids).take(this.Depth).map(BitforexMarketDataGateway.GetLevel).value();
        var asks = _(msg.asks).reverse().take(this.Depth).map(BitforexMarketDataGateway.GetLevel).value()
        var mkt = new Models.Market(bids, asks, depth.time);

        this.MarketData.trigger(mkt);
    };

    private _log = log("tribeca:gateway:BitofrexMD");
    constructor(socket : BitforexWebsocket, symbolProvider: BitforexSymbolProvider) {
        console.log(colors.green('BITFOREX START DATA GAEWAY'));
        var depthChannel = "depth10";
        var tradesChannel = "trade";
        
        socket.setHandler(depthChannel, this.onDepth);
        socket.setHandler(tradesChannel, this.onTrade);
        
        socket.ConnectChanged.on(cs => {
            this.ConnectChanged.trigger(cs);
            
            // if (cs == Models.ConnectivityStatus.Connected) {
            //     socket.send(depthChannel, {});
            //     socket.send(tradesChannel, {});
            // }
        });
    }
}

// Inigo V1
class BitforexOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusUpdate>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    generateClientOrderId = () => shortId.generate();
    
    supportsCancelAllOpenOrders = () : boolean => { return false; };
    cancelAllOpenOrders = () : Q.Promise<number> => { return Q(0); };

    public cancelsByClientOrderId = false;
    
    private static GetOrderType(side: Models.Side, type: Models.OrderType) : number {
        if (side === Models.Side.Bid) {
            return 1;
        }
        if (side === Models.Side.Ask) {
            return 2;
        }
        throw new Error("unable to convert " + Models.Side[side] + " and " + Models.OrderType[type]);
    }

    sendOrder = (order : Models.OrderStatusReport) => {
        var o : Order = {
            symbol: this._symbolProvider.coinSymbol,
            tradeType: BitforexOrderEntryGateway.GetOrderType(order.side, order.type),
            price: order.price,
            amount: order.quantity
        };

        var requestData = bitforexPlaceOrder(o);

        this._http.post(requestData.actionUrl, requestData.msg).then((data) => {
            this.onOrderAck(data);
            this.OrderUpdate.trigger({
                orderId: order.orderId,
                computationalLatency: Utils.fastDiff(Utils.date(), order.time)
            });
        }).done();
            
        // this._socket.send<OrderAck>("ok_spotusd_trade", this._signer.signMessage(o), () => {
        //     this.OrderUpdate.trigger({
        //         orderId: order.orderId,
        //         computationalLatency: Utils.fastDiff(Utils.date(), order.time)
        //     });
        // });
    };
    
    private onOrderAck = (ts: Models.Timestamped<any>) => {
        var orderId:string = ts.data.data.orderId.toString();
        var osr : Models.OrderStatusUpdate = { orderId: orderId, time: ts.time };
            
        if (ts.data.success === true) {
            osr.exchangeId = orderId;
            osr.orderStatus = Models.OrderStatus.Working;
        } 
        else {
            osr.orderStatus = Models.OrderStatus.Rejected;
        }
        
        this.OrderUpdate.trigger(osr);
    };

    cancelOrder = (cancel : Models.OrderStatusReport) => {
        var c : Cancel = {orderId: cancel.exchangeId, symbol: this._symbolProvider.coinSymbol };

        const requestData = bitforexCancelOrder(c);

        this._http.post(requestData.actionUrl, requestData.msg).then((data) => {
            this.onCancel(data, cancel.exchangeId.toString());
            this.OrderUpdate.trigger({
                orderId: cancel.orderId,
                computationalLatency: Utils.fastDiff(Utils.date(), cancel.time)
            });
        }).done();

        // this._socket.send<OrderAck>("ok_spotusd_cancel_order", this._signer.signMessage(c), () => {
        //     this.OrderUpdate.trigger({
        //         orderId: cancel.orderId,
        //         computationalLatency: Utils.fastDiff(Utils.date(), cancel.time)
        //     });
        // });
    };
    
    private onCancel = (ts: Models.Timestamped<any>, orderId: string) => {
        var osr : Models.OrderStatusUpdate = { exchangeId: orderId, time: ts.time };
            
        if (ts.data.success === true) {
            osr.orderStatus = Models.OrderStatus.Cancelled;
        }
        else {
            osr.orderStatus = Models.OrderStatus.Rejected;
            osr.cancelRejected = true;
        }
        
        this.OrderUpdate.trigger(osr);
    };

    replaceOrder = (replace : Models.OrderStatusReport) => {
        this.cancelOrder(replace);
        this.sendOrder(replace);
    };
    
    private static getStatus(status: number) : Models.OrderStatus {
        // status: -1: cancelled, 0: pending, 1: partially filled, 2: fully filled, 4: cancel request in process
        switch (status) {
            case -1: return Models.OrderStatus.Cancelled;
            case 0: return Models.OrderStatus.Working;
            case 1: return Models.OrderStatus.Working;
            case 2: return Models.OrderStatus.Complete;
            case 4: return Models.OrderStatus.Working;
            default: return Models.OrderStatus.Other;
        }
    }

    private onTrade = (tsMsg : Models.Timestamped<Array<BitforexTradeRecord>>) => {
        var t = tsMsg.time;
        var trades = tsMsg.data;
        for (var i = 0; i < trades.length; i++) {
            var msg : BitforexTradeRecord = trades[i];
        
            // var avgPx = parseFloat(msg.averagePrice);
            // var lastQty = parseFloat(msg.sigTradeAmount);
            // var lastPx = parseFloat(msg.sigTradePrice);

            var status : Models.OrderStatusUpdate = {
                exchangeId: msg.tid,
                orderStatus: BitforexOrderEntryGateway.getStatus(2),
                time: t,
                quantity: msg.amount,
                price: msg.price,
                // lastQuantity: lastQty > 0 ? lastQty : undefined,
                // lastPrice: lastPx > 0 ? lastPx : undefined,
                // averagePrice: avgPx > 0 ? avgPx : undefined,
                // pendingCancel: msg.status === 4,
                // partiallyFilled: msg.status === 1
            };

            this.OrderUpdate.trigger(status);
        }
    };

    private _log = log("tribeca:gateway:BitforexOE");
    constructor(
            private _socket : BitforexWebsocket, 
            private _http : BitforexHttp,
            private _signer: BitforexMessageSigner,
            private _symbolProvider: BitforexSymbolProvider) {
        // _socket.setHandler("ok_usd_realtrades", this.onTrade);
        // _socket.setHandler("ok_spotusd_trade", this.onOrderAck);
        // _socket.setHandler("ok_spotusd_cancel_order", this.onCancel);
        
        _socket.setHandler("trade", this.onTrade);
        
        _socket.ConnectChanged.on(cs => {
            this.ConnectChanged.trigger(cs);
            
            if (cs === Models.ConnectivityStatus.Connected) {
                _socket.send([
                    {
                        type: 'subHq',
                        event: 'depth10',
                        param: {
                            businessType: _symbolProvider.coinSymbol,
                            dType: 0,
                            size: 100,
                        }
                    },
                    {
                        type: 'subHq',
                        event: 'trade',
                        param: {
                            businessType: _symbolProvider.coinSymbol,
                            size: 100,
                        }
                    }
                ]);
            }
        });
    }
}

// Inigo v1
class BitforexMessageSigner {    
    public signMessage = (url: string, m : SignedMessage) : SignedMessage => {
        m.signData = generateSign(url, m);
        return m;
    };
    
    constructor(config : Config.IConfigProvider) {
    }
}

class BitforexHttp {
    post = <T>(actionUrl: string, msg : SignedMessage) : Q.Promise<Models.Timestamped<T>> => {
        var d = Q.defer<Models.Timestamped<T>>();

        request({
            url: url.resolve(this._baseUrl, actionUrl),
            body: querystring.stringify(this._signer.signMessage(actionUrl, msg)),
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            method: "POST"
        }, (err, resp, body) => {
            if (err) d.reject(err);
            else {
                try {
                    var t = Utils.date();
                    var data = JSON.parse(body);
                    d.resolve(new Models.Timestamped(data, t));
                }
                catch (e) {
                    this._log.error(err, "url: %s, err: %o, body: %o", actionUrl, err, body);
                    d.reject(e);
                }
            }
        });
        
        return d.promise;
    };

    private _log = log("tribeca:gateway:BitforexHTTP");
    private _baseUrl : string;
    constructor(config : Config.IConfigProvider, private _signer: BitforexMessageSigner) {
        this._baseUrl = config.GetString("BitforexHttpUrl")
    }
}

// Inigo V1
class BitforexPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    private static convertCurrency(name : string) : Models.Currency {
        switch (name.toLowerCase()) {
            case "usd": return Models.Currency.USD;
            case "gbt": return Models.Currency.GBT;
            case "btc": return Models.Currency.BTC;
            default: throw new Error("Unsupported currency " + name);
        }
    }

    private trigger = () => {
        const requestData = bitforexGetAllAssets();
        this._http.post<Array<any>>(requestData.actionUrl, requestData.msg).then(msg => {
            var currencies = msg.data || [];
            for (var i = 0; i < currencies.length; i++) {
                try {
                    var currency = currencies[i];
                    var currencyName = currency.currency;

                    var currencyModel = BitforexPositionGateway.convertCurrency(currencyName);

                    var amount = currency.active;
                    var held = currency.frozen;

                    var pos = new Models.CurrencyPosition(amount, held, currencyModel);
                    this.PositionUpdate.trigger(pos);
                } catch (e) {
                    console.log(e);
                }
            }
        }).done();
    };

    private _log = log("tribeca:gateway:BitofrexPG");
    constructor(private _http : BitforexHttp) {
        console.log(colors.green('BITFOREX START POSITION GATEWAY'));
        setInterval(this.trigger, 15000);
        setTimeout(this.trigger, 10);
    }
}

class BitforexBaseGateway implements Interfaces.IExchangeDetailsGateway {
    public get hasSelfTradePrevention() {
        return false;
    }

    name() : string {
        return "Bitforex";
    }

    makeFee() : number {
        return 0.001;
    }

    takeFee() : number {
        return 0.002;
    }

    exchange() : Models.Exchange {
        return Models.Exchange.Bitforex;
    }
    
    constructor(public minTickIncrement: number) {
        console.log(colors.green('BITFOREX START BASE GATEWAY'));
    }
}

// Inigo v1
class BitforexSymbolProvider {
    public symbol : string;
    public coinSymbol: string;
    public symbolWithoutUnderscore: string;
    
    constructor(pair: Models.CurrencyPair) {
        const GetCurrencySymbol = (s: Models.Currency) : string => Models.fromCurrency(s);
        this.symbol = GetCurrencySymbol(pair.base) + "_" + GetCurrencySymbol(pair.quote);
        this.coinSymbol = 'coin-' + GetCurrencySymbol(pair.quote).toLowerCase() + '-' + GetCurrencySymbol(pair.base).toLowerCase();
        this.symbolWithoutUnderscore = GetCurrencySymbol(pair.base) + GetCurrencySymbol(pair.quote);
    }
}

class Bitforex extends Interfaces.CombinedGateway {
    constructor(config : Config.IConfigProvider, pair: Models.CurrencyPair) {
        console.log(colors.green('BITFOREX START SYMBOL'));
        var symbol = new BitforexSymbolProvider(pair);
        console.log(colors.green('BITFOREX START SIGNER'));
        var signer = new BitforexMessageSigner(config);
        console.log(colors.green('BITFOREX START HTTP'));
        var http = new BitforexHttp(config, signer);
        console.log(colors.green('BITFOREX START SOCKET'));
        var socket = new BitforexWebsocket(config);

        console.log(colors.green('BITFOREX START ORDER ENTRY GATEWAY'));
        var orderGateway = config.GetString("BitforexOrderDestination") == "Bitforex"
            ? <Interfaces.IOrderEntryGateway>new BitforexOrderEntryGateway(socket, http, signer, symbol)
            : new NullGateway.NullOrderGateway();

        super(
            new BitforexMarketDataGateway(socket, symbol),
            orderGateway,
            new BitforexPositionGateway(http),
            new BitforexBaseGateway(.01)); // uh... todo
        }
}

// Inigo v1
export async function createBitforex(config : Config.IConfigProvider, pair: Models.CurrencyPair) : Promise<Interfaces.CombinedGateway> {
    console.log(colors.green('BITFOREX START'));
    API_KEY = config.GetString("BitforexApiKey")
    API_SECRET = config.GetString("BitforexSecretKey")
    return new Bitforex(config, pair);
}