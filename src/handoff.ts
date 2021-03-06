// tslint:disable: interface-name
import * as builder from "botbuilder";
import { Express } from "express";
import { MongooseProvider } from "./mongoose-provider";
import * as teams from "botbuilder-teams";
const indexExports = require("./index");

// Options for state of a conversation
// Customer talking to bot, waiting for next available agent or talking to an agent
export enum ConversationState {
    Bot,
    Waiting,
    Agent,
    Watch,
}

// What an entry in the customer transcript will have
export interface TranscriptLine {
    timestamp: any;
    from: string;
    sentimentScore?: number;
    state?: number;
    text: string;
}

// What is stored in a conversation. Agent only included if customer is talking to an agent
export interface Conversation {
    customer: builder.IAddress;
    agent?: builder.IAddress;
    state: ConversationState;
    transcript: TranscriptLine[];
}

export interface Team {
    teamId: string;
    teamName: string;
    conversation: string[];
}

// Used in getConversation in provider. Gives context to the search and changes behavior
export interface By {
    bestChoice?: true;
    agentConversationId?: string;
    customerConversationId?: string;
    customerName?: string;
    customerId?: string;
}

export interface Provider {

    // Update
    addToTranscript: (by: By, message: builder.IMessage, from?: string) => Promise<boolean>;
    connectCustomerToAgent: (by: By, nextState: ConversationState, agentAddress: builder.IAddress) => Promise<Conversation>;
    connectCustomerToBot: (by: By) => Promise<boolean>;
    queueCustomerForAgent: (by: By) => Promise<boolean>;

    // Get
    getConversation: (by: By, customerAddress?: builder.IAddress, teamId?: string, teamName?: string, tenantId?: string) => Promise<Conversation>;
    init();
}

export class Handoff {
    // if customizing, pass in your own check for isAgent and your own versions of methods in defaultProvider
    constructor(
        private bot: builder.UniversalBot,
        private connector: teams.TeamsChatConnector,
        public isAgent: (session: builder.Session) => boolean,
        private provider = new MongooseProvider(),
    ) {
        this.provider.init();
    }

    public routingMiddleware() {
        return {
            botbuilder: (session: builder.Session, next: () => void) => {
                // Pass incoming messages to routing method. They must have text or attachments
                if (session.message.type === "message" && (session.message.text !== "" || session.message.attachments)) {
                    this.routeMessage(session, next);
                } else {
                    // allow messages of non 'message' type through
                    next();
                }
            },
            send: async (event: builder.IMessage, next: () => void) => {
                // Messages sent from the bot do not need to be routed

                // skip agent messages
                if (event.address.conversation.id.split(";")[0] === indexExports._supportChannelId) {
                    next();
                } else if (event.type === "message" && !event.entities) {
                    // Not all messages from the bot are type message, we only want to record the actual messages
                    const message = event;
                    let customerConversation;
                    try {
                        customerConversation = await this.getConversation({ customerConversationId: event.address.conversation.id }, event.address);
                    } catch (err) {
                        console.log(err);
                    }
                    // send message to agent observing conversation
                    if (customerConversation.state === ConversationState.Watch) {
                        this.bot.send(new builder.Message().address(customerConversation.agent).text(message.text));
                    }
                    this.transcribeMessageFromBot(event as builder.IMessage, next);
                } else {
                    // If not a message (text), just send to user without transcribing
                    next();
                }
            },
        };
    }

    public async getCustomerTranscript(by: By, session: builder.Session) {
        const customerConversation = await this.getConversation(by);
        if (customerConversation) {
            let text = "";
            // only return the last 10
            customerConversation.transcript.slice(-10).forEach((transcriptLine) =>
                text += `**${transcriptLine.from}** (*${new Date(transcriptLine.timestamp).toLocaleString()} UTC*): ${transcriptLine.text}\n\n`,
            );
            session.send(text);
        } else {
            session.send("No Transcript to show. Try entering a username or try again when connected to a customer");
        }
    }

    public connectCustomerToAgent = async (by: By, nextState: ConversationState, agentAddress: builder.IAddress) => {
        return await this.provider.connectCustomerToAgent(by, nextState, agentAddress);
    }

    public connectCustomerToBot = async (by: By) => {
        return await this.provider.connectCustomerToBot(by);
    }

    public queueCustomerForAgent = async (by: By) => {
        return await this.provider.queueCustomerForAgent(by);
    }

    public addToTranscript = async (by: By, message: builder.IMessage): Promise<boolean> => {
        const from = by.agentConversationId ? "Agent" : "Customer";
        return await this.provider.addToTranscript(by, message, from);
    }

    public getConversation = async (by: By, customerAddress?: builder.IAddress, teamId?: string, teamName?: string, tenantId?: string) => {
        return await this.provider.getConversation(by, customerAddress, teamId, teamName, tenantId);
    }

    public getCurrentConversations = async (): Promise<Conversation[]> => {
        return await this.provider.getCurrentConversations();
    }

    public getCurrentTeams = async (): Promise<Team[]> => {
        return await this.provider.getCurrentTeams();
    }

    public getTeamConversations = async (teamName: string): Promise<Conversation[]> => {
        return await this.provider.getTeamConversations(teamName);
    }

    public getConversationTeam = async (convId: string): Promise<Team> => {
        return await this.provider.getConversationTeam(convId);
    }

    private routeMessage(session: builder.Session, next: () => void) {
        if (this.isAgent(session)) {
            this.routeAgentMessage(session);
        } else {
            this.routeCustomerMessage(session, next);
        }
    }

    private async routeAgentMessage(session: builder.Session) {
        const message = session.message;
        const conversation = await this.getConversation({ agentConversationId: message.address.conversation.id }, message.address);
        await this.addToTranscript({ agentConversationId: message.address.conversation.id }, message);
        // if the agent is not in conversation, no further routing is necessary
        if (!conversation) {
            return;
        }

        // if state of conversation is not 2, don't route agent message
        if (conversation.state !== ConversationState.Agent) {
            // error state -- should not happen
            session.send("Shouldn't be in this state - agent should have been cleared out.");
            return;
        }
        // send text that agent typed to the customer they are in conversation with
        this.bot.send(new builder.Message().address(conversation.customer).text(message.text).addEntity({ agent: true }));

    }

    private async routeCustomerMessage(session: builder.Session, next: () => void) {
        const message = session.message;
        // method will either return existing conversation or a newly created conversation if this is first time we've heard from customer
        let teamId = null;
        let tenantId = null;
        let teamName = null;
        if ((session.message as any).address.channelId === "msteams") {
            if (session.message.sourceEvent.team && session.message.sourceEvent.team.id) {
                teamId = session.message.sourceEvent.team.id;
            }
            tenantId = teams.TeamsMessage.getTenantId(session.message);

            // if in a team, get the name
            if (message.address.conversation.isGroup) {
                try {
                    teamName = await new Promise((resolve, reject) => {
                        this.connector.fetchTeamInfo(( session.message.address as builder.IChatConnectorAddress).serviceUrl,
                                                        teamId, (err, result) => {
                            if (err) { reject(err); } else { resolve(result.name); }
                        });
                    });
                } catch (e) {
                    console.log(`Error getting team name: ${e}`);
                }
            }
        }

        let conversation;
        try {
            conversation = await this.getConversation({ customerConversationId: message.address.conversation.id },
                                                            message.address, teamId, teamName, tenantId);
        } catch (e) {
            console.log(`Error getting conversation: ${e}`);
        }

        try {
            await this.addToTranscript({ customerConversationId: conversation.customer.conversation.id }, message);
        } catch (e) {
            console.log(`Error adding to transcript: ${e}`);
        }

        const textToSend = `**${session.message.address.user.name}** from **${teamName || "Private Chat"}**: \n\n ${session.message.text}`;
        session.message.text;
        if (teamName) {

        }

        switch (conversation.state) {
            case ConversationState.Bot:
                return next();
            case ConversationState.Waiting:
                return next();
            case ConversationState.Watch:
                this.bot.send(new builder.Message().address(conversation.agent).text(textToSend));
                return next();
            case ConversationState.Agent:
                if (!conversation.agent) {
                    session.send("No agent address present while customer in state Agent");
                    console.log("No agent address present while customer in state Agent");
                    return;
                }
                this.bot.send(new builder.Message().address(conversation.agent).text(textToSend));
                return;
        }
    }

    // These methods are wrappers around provider which handles data
    private transcribeMessageFromBot(message: builder.IMessage, next: () => void) {
        this.provider.addToTranscript({ customerConversationId: message.address.conversation.id }, message, "Bot");
        next();
    }
}
