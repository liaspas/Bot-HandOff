"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const bluebird = require("bluebird");
const request = require("request");
const _ = require("lodash");
const mongoose = require("mongoose");
exports.mongoose = mongoose;
mongoose.Promise = bluebird;
// fix deprecation warning
mongoose.set("useFindAndModify", false);
const handoff_1 = require("./handoff");
const indexExports = require("./index");
// -------------------
// Bot Framework types
// -------------------
exports.IIdentitySchema = new mongoose.Schema({
    id: { type: String, required: true },
    isGroup: { type: Boolean, required: false },
    name: { type: String, required: false },
}, {
    _id: false,
    strict: false,
});
exports.IAddressSchema = new mongoose.Schema({
    bot: { type: exports.IIdentitySchema, required: true },
    channelId: { type: String, required: true },
    conversation: { type: exports.IIdentitySchema, required: false },
    user: { type: exports.IIdentitySchema, required: true },
    id: { type: String, required: false },
    serviceUrl: { type: String, required: false },
    useAuth: { type: Boolean, required: false },
}, {
    strict: false,
    id: false,
    _id: false,
});
// -------------
// Handoff types
// -------------
exports.TranscriptLineSchema = new mongoose.Schema({
    timestamp: {},
    from: String,
    sentimentScore: Number,
    state: Number,
    text: String,
});
exports.ConversationSchema = new mongoose.Schema({
    customer: { type: exports.IAddressSchema, required: true },
    agent: { type: exports.IAddressSchema, required: false },
    state: {
        type: Number,
        required: true,
        min: 0,
        max: 3,
    },
    transcript: [exports.TranscriptLineSchema],
});
exports.ConversationModel = mongoose.model("Conversation", exports.ConversationSchema);
// Teams collection. It will point to its Conversation IDs
exports.TeamSchema = new mongoose.Schema({
    teamId: { type: String, required: false },
    tenantId: { type: String, required: false },
    channel: { type: String, required: true, default: "Teams" },
    teamName: { type: String, required: true },
    conversation: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: "Conversation",
        }],
});
exports.TeamModel = mongoose.model("Team", exports.TeamSchema);
exports.BySchema = new mongoose.Schema({
    bestChoice: Boolean,
    agentConversationId: String,
    customerConversationId: String,
    customerName: String,
    customerId: String,
});
exports.ByModel = mongoose.model("By", exports.BySchema);
// -----------------
// Mongoose Provider
// -----------------
class MongooseProvider {
    init() { }
    addToTranscript(by, message, from) {
        return __awaiter(this, void 0, void 0, function* () {
            let sentimentScore = -1;
            const text = message.text;
            let datetime = new Date().toISOString();
            const conversation = yield this.getConversation(by);
            if (!conversation) {
                return false;
            }
            if (from === "Customer") {
                if (indexExports._textAnalyticsKey) {
                    sentimentScore = yield this.collectSentiment(text);
                }
                datetime = message.localTimestamp ? message.localTimestamp : message.timestamp;
            }
            conversation.transcript.push({
                timestamp: datetime,
                from,
                sentimentScore,
                state: conversation.state,
                text,
            });
            if (indexExports._appInsights) {
                // You can't log embedded json objects in application insights, so we are flattening the object to one item.
                // Also, have to stringify the object so functions from mongodb don't get logged
                const latestTranscriptItem = conversation.transcript.length - 1;
                const x = JSON.parse(JSON.stringify(conversation.transcript[latestTranscriptItem]));
                x.botId = conversation.customer.bot.id;
                x.customerId = conversation.customer.user.id;
                x.customerName = conversation.customer.user.name;
                x.customerChannelId = conversation.customer.channelId;
                x.customerConversationId = conversation.customer.conversation.id;
                if (conversation.agent) {
                    x.agentId = conversation.agent.user.id;
                    x.agentName = conversation.agent.user.name;
                    x.agentChannelId = conversation.agent.channelId;
                    x.agentConversationId = conversation.agent.conversation.id;
                }
                indexExports._appInsights.client.trackEvent("Transcript", x);
            }
            return yield this.updateConversation(conversation);
        });
    }
    connectCustomerToAgent(by, stateUpdate, agentAddress) {
        return __awaiter(this, void 0, void 0, function* () {
            const conversation = yield this.getConversation(by);
            if (conversation) {
                conversation.state = stateUpdate;
                conversation.agent = agentAddress;
            }
            const success = yield this.updateConversation(conversation);
            if (success) {
                return conversation;
            }
            else {
                return null;
            }
        });
    }
    queueCustomerForAgent(by) {
        return __awaiter(this, void 0, void 0, function* () {
            const conversation = yield this.getConversation(by);
            if (!conversation) {
                return false;
            }
            else {
                conversation.state = handoff_1.ConversationState.Waiting;
                return yield this.updateConversation(conversation);
            }
        });
    }
    connectCustomerToBot(by) {
        return __awaiter(this, void 0, void 0, function* () {
            const conversation = yield this.getConversation(by);
            if (!conversation) {
                return false;
            }
            else {
                conversation.state = handoff_1.ConversationState.Bot;
                if (indexExports._retainData === "true") {
                    // if retain data is true, AND the user has spoken to an agent - delete the agent record
                    // this is necessary to avoid a bug where the agent cannot connect to another user after disconnecting with a user
                    if (conversation.agent) {
                        conversation.agent = null;
                        return yield this.updateConversation(conversation);
                    }
                    else {
                        // otherwise, just update the conversation
                        return yield this.updateConversation(conversation);
                    }
                }
                else {
                    // if retain data is false, delete the whole conversation after talking to agent
                    if (conversation.agent) {
                        return yield this.deleteConversation(conversation);
                    }
                    else {
                        // otherwise, just update the conversation
                        return yield this.updateConversation(conversation);
                    }
                }
            }
        });
    }
    getConversation(by, customerAddress, teamId, teamName, tenantId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (by.customerName) {
                const conversation = yield exports.ConversationModel.findOne({ "customer.user.name": by.customerName });
                return conversation;
            }
            else if (by.customerId) {
                const conversation = yield exports.ConversationModel.findOne({ "customer.user.id": by.customerId });
                return conversation;
            }
            else if (by.agentConversationId) {
                const conversation = yield exports.ConversationModel.findOne({ "agent.conversation.id": by.agentConversationId });
                if (conversation) {
                    return conversation;
                }
                else {
                    return null;
                }
            }
            else if (by.customerConversationId) {
                let conversation = yield exports.ConversationModel.findOne({ "customer.conversation.id": by.customerConversationId });
                if (!conversation && customerAddress) {
                    conversation = yield this.createConversation(customerAddress, teamId, teamName, tenantId);
                }
                return conversation;
            }
            else if (by.bestChoice) {
                let waitingLongest = yield this.getCurrentConversations();
                waitingLongest = waitingLongest
                    .filter((conversation) => conversation.state === handoff_1.ConversationState.Waiting)
                    .sort((x, y) => y.transcript[y.transcript.length - 1].timestamp - x.transcript[x.transcript.length - 1].timestamp);
                return waitingLongest.length > 0 && waitingLongest[0];
            }
            return null;
        });
    }
    getCurrentConversations() {
        return __awaiter(this, void 0, void 0, function* () {
            let conversations;
            try {
                conversations = yield exports.ConversationModel.find();
            }
            catch (error) {
                console.log("Failed loading conversations");
                console.log(error);
            }
            return conversations;
        });
    }
    getTeamConversations(teamName) {
        return __awaiter(this, void 0, void 0, function* () {
            let conversations;
            try {
                // find the coresponding conversations from the ids
                const model = yield exports.TeamModel.findOne({ teamName }).select("conversation").populate("conversation");
                conversations = model.conversation;
            }
            catch (error) {
                console.log("Failed loading conversations");
                console.log(error);
            }
            return conversations;
        });
    }
    getConversationTeam(convId) {
        return __awaiter(this, void 0, void 0, function* () {
            let team;
            const convIdObj = mongoose.Types.ObjectId(convId);
            try {
                team = yield exports.TeamModel.findOne({ conversation: convIdObj });
            }
            catch (error) {
                console.log("Failed getting conversation's team");
                console.log(error);
            }
            return team;
        });
    }
    getCurrentTeams() {
        return __awaiter(this, void 0, void 0, function* () {
            let teams;
            try {
                teams = yield exports.TeamModel.find();
            }
            catch (error) {
                console.log("Failed loading Teams");
                console.log(error);
            }
            return teams;
        });
    }
    createConversation(customerAddress, teamId, teamName, tenantId) {
        return __awaiter(this, void 0, void 0, function* () {
            const conversation = yield exports.ConversationModel.create({
                customer: customerAddress,
                state: handoff_1.ConversationState.Bot,
                transcript: [],
            });
            // find the team this conversation belongs to
            if (teamId == null) {
                teamId = null;
                teamName = "Personal Chat";
            }
            let team = yield exports.TeamModel.findOne({ teamName });
            // if it doesn't exist create it
            if (!team) {
                team = yield this.createTeam(teamId, teamName, tenantId);
            }
            // add the conversation to the team
            const success = yield this.updateTeam(team, conversation._id);
            if (!success) {
                return null;
            }
            return conversation;
        });
    }
    createTeam(teamId, teamName, tenantId) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield exports.TeamModel.create({
                teamId,
                teamName,
                tenantId,
                conversation: [],
            });
        });
    }
    updateTeam(team, convid) {
        return __awaiter(this, void 0, void 0, function* () {
            team.conversation.push(convid);
            return new Promise((resolve, reject) => {
                exports.TeamModel.findByIdAndUpdate(team._id, team).then((error) => {
                    resolve(true);
                }).catch((error) => {
                    console.log("Failed to update team");
                    console.log(team);
                    resolve(false);
                });
            });
        });
    }
    updateConversation(conversation) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                exports.ConversationModel.findByIdAndUpdate(conversation._id, conversation).then((error) => {
                    resolve(true);
                }).catch((error) => {
                    console.log("Failed to update conversation");
                    console.log(conversation);
                    resolve(false);
                });
            });
        });
    }
    deleteConversation(conversation) {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve) => {
                exports.ConversationModel.findByIdAndRemove(conversation._id).then((error) => {
                    resolve(true);
                });
            });
        });
    }
    collectSentiment(text) {
        return __awaiter(this, void 0, void 0, function* () {
            if (text == null || text === "") {
                return;
            }
            const _sentimentUrl = "https://westus.api.cognitive.microsoft.com/text/analytics/v2.0/sentiment";
            const _sentimentId = "bot-analytics";
            const _sentimentKey = indexExports._textAnalyticsKey;
            const options = {
                url: _sentimentUrl,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Ocp-Apim-Subscription-Key": _sentimentKey,
                },
                json: true,
                body: {
                    documents: [
                        {
                            language: "en",
                            id: _sentimentId,
                            text,
                        },
                    ],
                },
            };
            return new Promise((resolve, reject) => {
                request(options, (error, response, body) => {
                    if (error) {
                        reject(error);
                    }
                    const result = _.find(body.documents, { id: _sentimentId }) || {};
                    const score = result.score || null;
                    resolve(score);
                });
            });
        });
    }
}
exports.MongooseProvider = MongooseProvider;
//# sourceMappingURL=mongoose-provider.js.map