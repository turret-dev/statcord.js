// Modules
const fetch = require("node-fetch");
const si = require("systeminformation");
const ShardingUtil = require("./util/shardUtil");
const { EventEmitter } = require("events");

class ShardingClient extends EventEmitter {
    static post = ShardingUtil.post;
    static postCommand = ShardingUtil.postCommand;

    constructor(options) {
        super();

        const { key, manager } = options;
        let { postCpuStatistics, postMemStatistics, postNetworkStatistics, autopost } = options;

        // Check for discord.js
        try {
            this.discord = require("discord.js");
        } catch(e) {
            throw new Error("statcord.js needs discord.js to function");
        }

        // Key error handling
        if (!key) throw new Error('"key" is missing or undefined');
        if (typeof key !== "string") throw new TypeError('"key" is not typeof string');
        if (!key.startsWith("statcord.com-")) throw new Error('"key" is not prefixed by "statcord.com-", please follow the key format');
        // Manager error handling
        if (!manager) throw new Error('"manager" is missing or undefined');
        if (!(manager instanceof this.discord.ShardingManager)) throw new TypeError('"manager" is not a discord.js sharding manager');
        // Auto post arg checking
        if (!autopost == null || autopost == undefined) autopost = true;
        if (typeof autopost !== "boolean") throw new TypeError('"autopost" is not of type boolean');
        // Post arg error checking
        if (postCpuStatistics == null || postCpuStatistics == undefined) postCpuStatistics = true;
        if (typeof postCpuStatistics !== "boolean") throw new TypeError('"postCpuStatistics" is not of type boolean');
        if (postMemStatistics == null || postMemStatistics == undefined) postMemStatistics = true;
        if (typeof postMemStatistics !== "boolean") throw new TypeError('"postMemStatistics" is not of type boolean');
        if (postNetworkStatistics == null || postNetworkStatistics == undefined) postNetworkStatistics = true;
        if (typeof postNetworkStatistics !== "boolean") throw new TypeError('"postNetworkStatistics" is not of type boolean');

        // Local config
        this.autoposting = autopost;

        // API config
        this.baseApiUrl = "https://statcord.com/logan/stats";
        this.key = key;
        this.manager = manager;

        // General config
        this.v11 = this.discord.version <= "12.0.0";
        this.v12 = this.discord.version >= "12.0.0";
        this.activeUsers = [];
        this.commandsRun = 0;
        this.popularCommands = [];
        this.used_bytes = 0;

        // Opt ins
        this.postCpuStatistics = postCpuStatistics;
        this.postMemStatistics = postMemStatistics;
        this.postNetworkStatistics = postNetworkStatistics;
        
        // Create custom fields map
        this.customFields = new Map();

        // Check if all shards have been spawned
        this.manager.on("shardCreate", (shard) => {
            // Get current shard
            let currShard = this.manager.shards.get(shard.id);

            // If this is the last shard, wait until it is ready
            if (shard.id + 1 == this.manager.totalShards && autopost) {
                // When ready start auto post
                currShard.once("ready", () => {
                    setTimeout(async () => {
                        this.emit("autopost-start");

                        this.post();

                        setInterval(async () => {
                            await this.post();
                        }, 60000);
                    }, 200);
                });
            }

            // Start message listener
            currShard.on("message", async (message) => {
                // If there is no message or it isn't a string (ignore broadcastEvals)
                if (!message || typeof message !== "string") return;

                // Check if they are statcord messages
                if (!message.startsWith("ssc")) return;
                let args = message.split("|=-ssc-=|"); // get the args

                if (args[0] == "sscpc") { // PostCommand message
                    await this.postCommand(args[1], args[2]);
                } else if (args[0] == "sscp") { // Post message
                        let post = await this.post();
                        if (post) this.emit("error", post);
                    }
            });
        });
    }

    // Post stats to API
    async post() {
        let bandwidth = 0;

        if (this.postNetworkStatistics) {
            // Set initial used network bytes count
            if (this.used_bytes <= 0) this.used_bytes = (await si.networkStats()).reduce((prev, current) => prev + current.rx_bytes, 0);

            // Calculate used bandwidth
            let used_bytes_latest = (await si.networkStats()).reduce((prev, current) => prev + current.rx_bytes, 0);
            bandwidth = used_bytes_latest - this.used_bytes;
            this.used_bytes = used_bytes_latest;
        }

        // counts
        let guild_count = 0;
        let user_count = 0;

        // V12 code
        if (this.v12) {
            guild_count = await getGuildCountV12(this.manager);
            user_count = await getUserCountV12(this.manager);
        } else if (this.v11) { // V11 code
            guild_count = await getGuildCountV11(this.manager);
            user_count = await getUserCountV11(this.manager);
        }

        // Get and sort popular commands
        let popular = [];

        let sortedPopular = this.popularCommands.sort((a, b) => a.count - b.count).reverse();

        for (let i = 0; i < sortedPopular.length; i++) {
            popular.push({
                name: sortedPopular[i].name,
                count: `${sortedPopular[i].count}`
            });
        }

        // Limit popular to the 5 most popular
        if (popular.length > 5) popular.length = 5;

        // Get system information
        let memactive = 0;
        let memload = 0;
        let cpuload = 0;

        // Get mem stats
        if (this.postMemStatistics) {
            const mem = await si.mem();

            // Get active memory in MB
            memactive = mem.active;
            // Get active mem load in %
            memload = Math.round(mem.active / mem.total * 100);
        }

        // Get cpu stats
        if (this.postCpuStatistics) {
            const platform = require("os").platform();

            // Current load is not avaliable on bsd
            if (platform !== "freebsd" && platform !== "netbsd" && platform !== "openbsd") {
                const load = await si.currentLoad();

                // Get current load
                cpuload = Math.round(load.currentload);
            }
        }

        // Get client id
        let id = (await this.manager.broadcastEval("this.user.id"))[0];

        // Post data
        let requestBody = {
            id, // Client id
            key: this.key, // API key
            servers: guild_count.toString(), // Server count
            users: user_count.toString(), // User count
            active: this.activeUsers, // Users that have run commands since the last post
            commands: this.commandsRun.toString(), // The how many commands have been run total
            popular, // the top 5 commands run and how many times they have been run
            memactive: memactive.toString(), // Actively used memory
            memload: memload.toString(), // Active memory load in %
            cpuload: cpuload.toString(), // CPU load in %
            bandwidth: bandwidth.toString(), // Used bandwidth in bytes
            custom1: "0", // Custom field 1
            custom2: "0" // Custom field 2
        }

        // Get custom field one value
        if (this.customFields.get(1)) {
            requestBody.custom1 = await this.customFields.get(1)(this.manager);
        }

        // Get custom field two value
        if (this.customFields.get(2)) {
            requestBody.custom2 = await this.customFields.get(2)(this.manager);
        }     

        // Reset stats
        this.activeUsers = [];
        this.commandsRun = 0;
        this.popularCommands = [];

        // Create post request
        let response;
        try {
            response = await fetch(this.baseApiUrl, {
                method: "post",
                body: JSON.stringify(requestBody),
                headers: {
                    "Content-Type": "application/json"
                }
            });
        } catch (e) {
            this.emit("post", "Unable to connect to the Statcord server. Going to automatically try again in 60 seconds, if this problem persists, please visit status.statcord.com");

            if (!this.autoposting) {
                setTimeout(() => {
                    this.post();
                }, 60000);
            }

            return;
        }

        // Statcord server side errors
        if (response.status >= 500) {
            this.emit("post", new Error(`Statcord server error, statuscode: ${response.status}`));
            return;
        }

        // Get body as JSON
        let responseData;
        try {
            responseData = await response.json();
        } catch {
            this.emit("post", new Error(`Statcord server error, invalid json response`));
            return;
        }

        // Check response for errors
        if (response.status == 200) {
            // Success
            this.emit("post", false);
        } else if (response.status == 400 || response.status == 429) {
            // Bad request or rate limit hit
            if (responseData.error) this.emit("post", new Error(responseData.message));
        } else {
            // Other
            this.emit("post", new Error("An unknown error has occurred"));
        }
    }

    // Post stats about a command
    async postCommand(command_name, author_id) {
        // Command name error checking
        if (!command_name) throw new Error('"command_name" is missing or undefined');
        if (typeof command_name !== "string") throw new TypeError('"command_name" is not typeof string');
        // Author id error checking
        if (!author_id) throw new Error('"author_id" is missing or undefined');
        if (typeof author_id !== "string") throw new TypeError('"author_id" is not typeof string');

        // Add the user to the active users list if they aren't already there
        if (!this.activeUsers.includes(author_id)) this.activeUsers.push(author_id);

        // Check if the popular commands has this command
        if (!this.popularCommands.some(command => command.name == command_name)) {
            // If it doesn't exist add to the array
            this.popularCommands.push({
                name: command_name,
                count: 1
            });
        } else {
            // If it does exist increment the count of the command
            let commandIndex = this.popularCommands.findIndex(command => command.name == command_name);
            // Increment the command count
            this.popularCommands[commandIndex].count++;
        }

        // Increment the commandsRun variable
        this.commandsRun++;
    }

    // Register the function to get the values for posting
    registerCustomFieldHandler(customFieldNumber, handler) {
        // Check if the handler already exists
        if (this.customFields.get(customFieldNumber)) return new Error("Handler already exists");

        // If it doen't set it
        this.customFields.set(customFieldNumber, handler);
    }
}

// V12 sharding gets 
async function getGuildCountV12(manager) {
    return (await manager.fetchClientValues("guilds.cache.size")).reduce((prev, current) => prev + current, 0);
}

async function getUserCountV12(manager) {
    const memberNum = await manager.broadcastEval('this.guilds.cache.reduce((prev, guild) => prev + guild.memberCount, 0)');
    return memberNum.reduce((prev, memberCount) => prev + memberCount, 0);
}
// end

// v11 sharding gets
async function getGuildCountV11(manager) {
    return (await manager.fetchClientValues("guilds.size")).reduce((prev, current) => prev + current, 0);
}

async function getUserCountV11(manager) {
    return (await manager.fetchClientValues("users.size")).reduce((prev, current) => prev + current, 0);
}
//end

module.exports = ShardingClient;