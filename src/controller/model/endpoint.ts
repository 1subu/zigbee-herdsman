import Entity from './entity';
import {KeyValue} from '../tstype';
import * as Zcl from '../../zcl';
import ZclTransactionSequenceNumber from '../helpers/zclTransactionSequenceNumber';
import * as ZclFrameConverter from '../helpers/zclFrameConverter';
import Group from './group';
import Device from './device';
import Debug from "debug";
import assert from 'assert';

const debug = {
    info: Debug('zigbee-herdsman:controller:endpoint'),
    error: Debug('zigbee-herdsman:controller:endpoint'),
};

interface ConfigureReportingItem {
    attribute: string | number | {ID: number; type: number};
    minimumReportInterval: number;
    maximumReportInterval: number;
    reportableChange: number;
}

interface Options {
    manufacturerCode?: number;
    disableDefaultResponse?: boolean;
    disableResponse?: boolean;
    timeout?: number;
    direction?: Zcl.Direction;
    srcEndpoint?: number;
    reservedBits?: number;
    transactionSequenceNumber?: number;
    disableRecovery?: boolean;
}

interface Clusters {
    [cluster: string]: {
        attributes: {[attribute: string]: number | string};
    };
}

interface BindInternal {
    cluster: number;
    type: 'endpoint' | 'group';
    deviceIeeeAddress?: string;
    endpointID?: number;
    groupID?: number;
}

interface Bind {
    cluster: Zcl.TsType.Cluster;
    target: Endpoint | Group;
}

class Endpoint extends Entity {
    public deviceID?: number;
    public inputClusters: number[];
    public outputClusters: number[];
    public profileID?: number;
    public readonly ID: number;
    public readonly clusters: Clusters;
    private readonly deviceIeeeAddress: string;
    public deviceNetworkAddress: number;
    private _binds: BindInternal[];
    private meta: KeyValue;

    // Getters/setters
    get binds(): Bind[] {
        return this._binds.map((entry) => {
            let target: Group | Endpoint = null;
            if (entry.type === 'endpoint') {
                const device = Device.byIeeeAddr(entry.deviceIeeeAddress);
                if (device) {
                    target = device.getEndpoint(entry.endpointID);
                }
            } else {
                target = Group.byGroupID(entry.groupID);
            }

            if (target) {
                return {target, cluster: Zcl.Utils.getCluster(entry.cluster)};
            } else {
                return undefined;
            }
        }).filter(b => b !== undefined);
    }

    private constructor(
        ID: number, profileID: number, deviceID: number, inputClusters: number[], outputClusters: number[],
        deviceNetworkAddress: number, deviceIeeeAddress: string, clusters: Clusters, binds: BindInternal[],
        meta: KeyValue,
    ) {
        super();
        this.ID = ID;
        this.profileID = profileID;
        this.deviceID = deviceID;
        this.inputClusters = inputClusters;
        this.outputClusters = outputClusters;
        this.deviceNetworkAddress = deviceNetworkAddress;
        this.deviceIeeeAddress = deviceIeeeAddress;
        this.clusters = clusters;
        this._binds = binds;
        this.meta = meta;
    }

    /**
     * Get device of this endpoint
     */
    public getDevice(): Device {
        return Device.byIeeeAddr(this.deviceIeeeAddress);
    }

    /**
     * @param {number|string} clusterKey
     * @returns {boolean}
     */
    public supportsInputCluster(clusterKey: number | string, ): boolean {
        const cluster = Zcl.Utils.getCluster(clusterKey);
        return this.inputClusters.includes(cluster.ID);
    }

    /**
     * @param {number|string} clusterKey
     * @returns {boolean}
     */
    public supportsOutputCluster(clusterKey: number | string, ): boolean {
        const cluster = Zcl.Utils.getCluster(clusterKey);
        return this.outputClusters.includes(cluster.ID);
    }

    /**
     * @returns {Zcl.TsType.Cluster[]}
     */
    public getInputClusters(): Zcl.TsType.Cluster[] {
        return this.clusterNumbersToClusters(this.inputClusters);
    }

    /**
     * @returns {Zcl.TsType.Cluster[]}
     */
    public getOutputClusters(): Zcl.TsType.Cluster[] {
        return this.clusterNumbersToClusters(this.outputClusters);
    }

    private clusterNumbersToClusters(clusterNumbers: number[]): Zcl.TsType.Cluster[] {
        return clusterNumbers.map((c) => {
            try {
                return Zcl.Utils.getCluster(c, this.getDevice().manufacturerID);
            } catch {
                return null;
            }
        }).filter((c) => c !== null);
    }

    /*
     * CRUD
     */

    public static fromDatabaseRecord(
        record: KeyValue, deviceNetworkAddress: number, deviceIeeeAddress: string
    ): Endpoint {
        // Migrate attrs to attributes
        for (const entry of Object.values(record.clusters).filter((e) => e.hasOwnProperty('attrs'))) {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            entry.attributes = entry.attrs;
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            delete entry.attrs;
        }

        const meta = record.meta ? record.meta : {};
        return new Endpoint(
            record.epId, record.profId, record.devId, record.inClusterList, record.outClusterList,
            deviceNetworkAddress, deviceIeeeAddress, record.clusters, record.binds || [], meta
        );
    }

    public toDatabaseRecord(): KeyValue {
        return {
            profId: this.profileID, epId: this.ID, devId: this.deviceID,
            inClusterList: this.inputClusters, outClusterList: this.outputClusters, clusters: this.clusters,
            binds: this._binds, meta: this.meta,
        };
    }

    public static create(
        ID: number, profileID: number, deviceID: number, inputClusters: number[], outputClusters: number[],
        deviceNetworkAddress: number, deviceIeeeAddress: string,
    ): Endpoint {
        return new Endpoint(
            ID, profileID, deviceID, inputClusters, outputClusters, deviceNetworkAddress,
            deviceIeeeAddress, {}, [], {},
        );
    }

    public saveClusterAttributeKeyValue(clusterKey: number | string, list: KeyValue): void {
        const cluster = Zcl.Utils.getCluster(clusterKey);
        if (!this.clusters[cluster.name]) this.clusters[cluster.name] = {attributes: {}};

        for (const [attribute, value] of Object.entries(list)) {
            this.clusters[cluster.name].attributes[attribute] = value;
        }
    }

    public getClusterAttributeValue(clusterKey: number | string, attributeKey: number | string): number | string {
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const attribute = cluster.getAttribute(attributeKey);
        if (this.clusters[cluster.name] && this.clusters[cluster.name].attributes) {
            return this.clusters[cluster.name].attributes[attribute.name];
        }

        return null;
    }

    /*
     * Zigbee functions
     */

    private checkStatus(payload: [{status: Zcl.Status}]): void {
        for (const item of payload) {
            if (item.status !== Zcl.Status.SUCCESS) {
                throw new Zcl.ZclStatusError(item.status);
            }
        }
    }

    public async write(
        clusterKey: number | string, attributes: KeyValue, options?: Options
    ): Promise<void> {
        options = this.getOptionsWithDefaults(options, true, Zcl.Direction.CLIENT_TO_SERVER);
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const payload: {attrId: number; dataType: number; attrData: number| string | boolean}[] = [];
        for (const [nameOrID, value] of Object.entries(attributes)) {
            if (cluster.hasAttribute(nameOrID)) {
                const attribute = cluster.getAttribute(nameOrID);
                payload.push({attrId: attribute.ID, attrData: value, dataType: attribute.type});
            } else if (!isNaN(Number(nameOrID))){
                payload.push({attrId: Number(nameOrID), attrData: value.value, dataType: value.type});
            } else {
                throw new Error(`Unknown attribute '${nameOrID}', specify either an existing attribute or a number`);
            }
        }

        const log = `Write ${this.deviceIeeeAddress}/${this.ID} ` +
            `${cluster.name}(${JSON.stringify(attributes)}, ${JSON.stringify(options)})`;
        debug.info(log);

        try {
            const frame = Zcl.ZclFrame.create(
                Zcl.FrameType.GLOBAL, options.direction, options.disableDefaultResponse,
                options.manufacturerCode, options.transactionSequenceNumber ?? ZclTransactionSequenceNumber.next(),
                'write', cluster.ID, payload, options.reservedBits
            );
            const result = await Entity.adapter.sendZclFrameToEndpoint(
                this.deviceIeeeAddress, this.deviceNetworkAddress, this.ID, frame, options.timeout,
                options.disableResponse, options.disableRecovery, options.srcEndpoint,
            );

            if (!options.disableResponse) {
                this.checkStatus(result.frame.Payload);
            }
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public async read(
        clusterKey: number | string, attributes: string[] | number [], options?: Options
    ): Promise<KeyValue> {
        options = this.getOptionsWithDefaults(options, true, Zcl.Direction.CLIENT_TO_SERVER);
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const payload: {attrId: number}[] = [];
        for (const attribute of attributes) {
            payload.push({attrId: typeof attribute === 'number' ? attribute : cluster.getAttribute(attribute).ID});
        }

        const frame = Zcl.ZclFrame.create(
            Zcl.FrameType.GLOBAL, options.direction, options.disableDefaultResponse,
            options.manufacturerCode, options.transactionSequenceNumber ?? ZclTransactionSequenceNumber.next(), 'read',
            cluster.ID, payload, options.reservedBits
        );

        const log = `Read ${this.deviceIeeeAddress}/${this.ID} ` +
            `${cluster.name}(${JSON.stringify(attributes)}, ${JSON.stringify(options)})`;
        debug.info(log);

        try {
            const result = await Entity.adapter.sendZclFrameToEndpoint(
                this.deviceIeeeAddress, this.deviceNetworkAddress, this.ID, frame, options.timeout,
                options.disableResponse, options.disableRecovery, options.srcEndpoint,
            );

            if (!options.disableResponse) {
                this.checkStatus(result.frame.Payload);
                return ZclFrameConverter.attributeKeyValue(result.frame);
            } else {
                return null;
            }
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public async readResponse(
        clusterKey: number | string, transactionSequenceNumber: number, attributes: KeyValue, options?: Options
    ): Promise<void> {
        assert(!options || !options.hasOwnProperty('transactionSequenceNumber'), 'Use parameter');
        options = this.getOptionsWithDefaults(options, true, Zcl.Direction.SERVER_TO_CLIENT);
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const payload: {attrId: number; status: number; dataType: number; attrData: number | string}[] = [];
        for (const [nameOrID, value] of Object.entries(attributes)) {
            if (cluster.hasAttribute(nameOrID)) {
                const attribute = cluster.getAttribute(nameOrID);
                payload.push({attrId: attribute.ID, attrData: value, dataType: attribute.type, status: 0});
            } else if (!isNaN(Number(nameOrID))){
                payload.push({attrId: Number(nameOrID), attrData: value.value, dataType: value.type, status: 0});
            } else {
                throw new Error(`Unknown attribute '${nameOrID}', specify either an existing attribute or a number`);
            }
        }

        const frame = Zcl.ZclFrame.create(
            Zcl.FrameType.GLOBAL, options.direction, options.disableDefaultResponse,
            options.manufacturerCode, transactionSequenceNumber, 'readRsp', cluster.ID, payload, options.reservedBits
        );

        const log = `ReadResponse ${this.deviceIeeeAddress}/${this.ID} ` +
            `${cluster.name}(${JSON.stringify(attributes)}, ${JSON.stringify(options)})`;
        debug.info(log);

        try {
            await Entity.adapter.sendZclFrameToEndpoint(
                this.deviceIeeeAddress, this.deviceNetworkAddress, this.ID, frame, options.timeout,
                options.disableResponse, options.disableRecovery, options.srcEndpoint
            );
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public async bind(clusterKey: number | string, target: Endpoint | Group | number): Promise<void> {
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const type = target instanceof Endpoint ? 'endpoint' : 'group';
        if (typeof target === 'number') {
            target = Group.byGroupID(target) || Group.create(target);
        }

        const destinationAddress = target instanceof Endpoint ? target.deviceIeeeAddress : target.groupID;

        const log = `Bind ${this.deviceIeeeAddress}/${this.ID} ${cluster.name} from ` +
            `'${target instanceof Endpoint ? `${destinationAddress}/${target.ID}` : destinationAddress}'`;
        debug.info(log);

        try {
            await Entity.adapter.bind(
                this.deviceNetworkAddress, this.deviceIeeeAddress, this.ID, cluster.ID, destinationAddress, type,
                target instanceof Endpoint ? target.ID : null,
            );

            if (!this.binds.find((b) => b.cluster.ID === cluster.ID && b.target === target)) {
                if (target instanceof Group) {
                    this._binds.push({cluster: cluster.ID, groupID: target.groupID, type: 'group'});
                } else {
                    this._binds.push({
                        cluster: cluster.ID, type: 'endpoint', deviceIeeeAddress: target.deviceIeeeAddress,
                        endpointID: target.ID
                    });
                }

                this.save();
            }
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public save(): void {
        this.getDevice().save();
    }

    public async unbind(clusterKey: number | string, target: Endpoint | Group | number): Promise<void> {
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const type = target instanceof Endpoint ? 'endpoint' : 'group';

        const destinationAddress =
            target instanceof Endpoint ? target.deviceIeeeAddress : (target instanceof Group ? target.groupID : target);

        const log = `Unbind ${this.deviceIeeeAddress}/${this.ID} ${cluster.name} from ` +
            `'${target instanceof Endpoint ? `${destinationAddress}/${target.ID}` : destinationAddress}'`;
        debug.info(log);

        try {
            await Entity.adapter.unbind(
                this.deviceNetworkAddress, this.deviceIeeeAddress, this.ID, cluster.ID, destinationAddress, type,
                target instanceof Endpoint ? target.ID : null,
            );

            const index = this.binds.findIndex((b) => b.cluster.ID === cluster.ID && b.target === target);
            if (index !== -1) {
                this._binds.splice(index, 1);
                this.save();
            }
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public async defaultResponse(
        commandID: number, status: number, clusterID: number, transactionSequenceNumber: number, options?: Options
    ): Promise<void> {
        assert(!options || !options.hasOwnProperty('transactionSequenceNumber'), 'Use parameter');
        options = this.getOptionsWithDefaults(options, true, Zcl.Direction.SERVER_TO_CLIENT);
        const payload = {cmdId: commandID, statusCode: status};
        const frame = Zcl.ZclFrame.create(
            Zcl.FrameType.GLOBAL, options.direction, options.disableDefaultResponse,
            options.manufacturerCode, transactionSequenceNumber, 'defaultRsp', clusterID, payload, options.reservedBits
        );

        const log = `DefaultResponse ${this.deviceIeeeAddress}/${this.ID} ` +
            `${clusterID}(${commandID}, ${JSON.stringify(options)})`;
        debug.info(log);

        try {
            await Entity.adapter.sendZclFrameToEndpoint(
                this.deviceIeeeAddress, this.deviceNetworkAddress, this.ID, frame, options.timeout,
                options.disableResponse, options.disableRecovery, options.srcEndpoint
            );
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public async configureReporting(
        clusterKey: number | string, items: ConfigureReportingItem[], options?: Options
    ): Promise<void> {
        options = this.getOptionsWithDefaults(options, true, Zcl.Direction.CLIENT_TO_SERVER);
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const payload = items.map((item): KeyValue => {
            let dataType, attrId;

            if (typeof item.attribute === 'object') {
                dataType = item.attribute.type;
                attrId = item.attribute.ID;
            } else {
                /* istanbul ignore else */
                if (cluster.hasAttribute(item.attribute)) {
                    const attribute = cluster.getAttribute(item.attribute);
                    dataType = attribute.type;
                    attrId = attribute.ID;
                }
            }

            return {
                direction: Zcl.Direction.CLIENT_TO_SERVER,
                attrId, dataType,
                minRepIntval: item.minimumReportInterval,
                maxRepIntval: item.maximumReportInterval,
                repChange: item.reportableChange,
            };
        });

        const frame = Zcl.ZclFrame.create(
            Zcl.FrameType.GLOBAL, options.direction, options.disableDefaultResponse,
            options.manufacturerCode, options.transactionSequenceNumber ?? ZclTransactionSequenceNumber.next(),
            'configReport', cluster.ID, payload, options.reservedBits
        );

        const log = `ConfigureReporting ${this.deviceIeeeAddress}/${this.ID} ` +
            `${cluster.name}(${JSON.stringify(items)}, ${JSON.stringify(options)})`;
        debug.info(log);

        try {
            const result = await Entity.adapter.sendZclFrameToEndpoint(
                this.deviceIeeeAddress, this.deviceNetworkAddress, this.ID, frame, options.timeout,
                options.disableResponse, options.disableRecovery, options.srcEndpoint
            );

            if (!options.disableResponse) {
                this.checkStatus(result.frame.Payload);
            }
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public async command(
        clusterKey: number | string, commandKey: number | string, payload: KeyValue, options?: Options,
    ): Promise<void | KeyValue> {
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const command = cluster.getCommand(commandKey);
        const hasResponse = command.hasOwnProperty('response');
        options = this.getOptionsWithDefaults(options, hasResponse, Zcl.Direction.CLIENT_TO_SERVER);

        const frame = Zcl.ZclFrame.create(
            Zcl.FrameType.SPECIFIC, options.direction, options.disableDefaultResponse,
            options.manufacturerCode, options.transactionSequenceNumber ?? ZclTransactionSequenceNumber.next(),
            command.ID, cluster.ID, payload, options.reservedBits
        );

        const log = `Command ${this.deviceIeeeAddress}/${this.ID} ` +
            `${cluster.name}.${command.name}(${JSON.stringify(payload)}, ${JSON.stringify(options)})`;
        debug.info(log);

        try {
            const result = await Entity.adapter.sendZclFrameToEndpoint(
                this.deviceIeeeAddress, this.deviceNetworkAddress, this.ID, frame, options.timeout,
                options.disableResponse, options.disableRecovery, options.srcEndpoint
            );

            if (result) {
                return result.frame.Payload;
            }
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public async commandResponse(
        clusterKey: number | string, commandKey: number | string, payload: KeyValue, options?: Options,
        transactionSequenceNumber?: number
    ): Promise<void | KeyValue> {
        assert(!options || !options.hasOwnProperty('transactionSequenceNumber'), 'Use parameter');
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const command = cluster.getCommandResponse(commandKey);
        transactionSequenceNumber = transactionSequenceNumber || ZclTransactionSequenceNumber.next();
        options = this.getOptionsWithDefaults(options, true, Zcl.Direction.SERVER_TO_CLIENT);

        const frame = Zcl.ZclFrame.create(
            Zcl.FrameType.SPECIFIC, options.direction, options.disableDefaultResponse,
            options.manufacturerCode, transactionSequenceNumber, command.ID, cluster.ID, payload, options.reservedBits
        );

        const log = `CommandResponse ${this.deviceIeeeAddress}/${this.ID} ` +
            `${cluster.name}.${command.name}(${JSON.stringify(payload)}, ${JSON.stringify(options)})`;
        debug.info(log);

        try {
            await Entity.adapter.sendZclFrameToEndpoint(
                this.deviceIeeeAddress, this.deviceNetworkAddress, this.ID, frame, options.timeout,
                options.disableResponse, options.disableRecovery, options.srcEndpoint
            );
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public waitForCommand(
        clusterKey: number | string, commandKey: number | string, transactionSequenceNumber: number, timeout: number,
    ): {promise: Promise<{header: KeyValue; payload: KeyValue}>; cancel: () => void} {
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const command = cluster.getCommand(commandKey);
        const waiter = Entity.adapter.waitFor(
            this.deviceNetworkAddress, this.ID, Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER,
            transactionSequenceNumber, cluster.ID, command.ID, timeout
        );

        const promise = new Promise<{header: KeyValue; payload: KeyValue}>((resolve, reject) => {
            waiter.promise.then(
                (payload) => resolve({header: payload.frame.Header, payload: payload.frame.Payload}),
                (error) => reject(error),
            );
        });

        return {promise, cancel: waiter.cancel};
    }

    private getOptionsWithDefaults(
        options: Options, disableDefaultResponse: boolean, direction: Zcl.Direction
    ): Options {
        const providedOptions = options || {};
        return {
            timeout: 10000,
            disableResponse: false,
            disableRecovery: false,
            disableDefaultResponse,
            direction,
            srcEndpoint: null,
            reservedBits: 0,
            manufacturerCode: null,
            transactionSequenceNumber: null,
            ...providedOptions
        };
    }

    public async addToGroup(group: Group): Promise<void> {
        await this.command('genGroups', 'add', {groupid: group.groupID, groupname: ''});
        group.addMember(this);
    }

    /**
     * Remove endpoint from a group, accepts both a Group and number as parameter.
     * The number parameter type should only be used when removing from a group which is not known
     * to zigbee-herdsman.
     */
    public async removeFromGroup(group: Group | number): Promise<void> {
        await this.command('genGroups', 'remove', {groupid: group instanceof Group ? group.groupID : group});
        if (group instanceof Group) {
            group.removeMember(this);
        }
    }

    public async removeFromAllGroups(): Promise<void> {
        await this.command('genGroups', 'removeAll', {}, {disableDefaultResponse: true});
        this.removeFromAllGroupsDatabase();
    }

    public removeFromAllGroupsDatabase(): void {
        for (const group of Group.all()) {
            if (group.hasMember(this)) {
                group.removeMember(this);
            }
        }
    }
}

export default Endpoint;