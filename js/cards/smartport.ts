import { debug, toHex } from '../util';
import { rom as smartPortRom } from '../roms/cards/smartport';
import { Card, Restorable, byte, word, rom } from '../types';
import { MassStorage, BlockDisk, ENCODING_BLOCK, BlockFormat, MassStorageData, DiskFormat } from '../formats/types';
import CPU6502, { CpuState, flags } from '../cpu6502';
import { create2MGFromBlockDisk, HeaderData, read2MGHeader } from '../formats/2mg';
import createBlockDisk from '../formats/block';
import { DriveNumber } from '../formats/types';

const ID = 'SMARTPORT.J.S';

export interface SmartPortState {
    disks: BlockDisk[];
}

export interface SmartPortOptions {
    block: boolean;
}

export interface Callbacks {
    driveLight: (driveNo: DriveNumber, on: boolean) => void;
    dirty: (driveNo: DriveNumber, dirty: boolean) => void;
    label: (driveNo: DriveNumber, name?: string, side?: string) => void;
}

class Address {
    lo: byte;
    hi: byte;

    constructor(private cpu: CPU6502, a: byte | word, b?: byte) {
        if (b === undefined) {
            this.lo = a & 0xff;
            this.hi = a >> 8;
        } else {
            this.lo = a;
            this.hi = b;
        }
    }

    loByte() {
        return this.lo;
    }

    hiByte() {
        return this.hi;
    }

    inc(val: byte) {
        return new Address(this.cpu, ((this.hi << 8 | this.lo) + val) & 0xffff);
    }

    readByte() {
        return this.cpu.read(this.hi, this.lo);
    }

    readWord() {
        const readLo = this.readByte();
        const readHi = this.inc(1).readByte();

        return readHi << 8 | readLo;
    }

    readAddress() {
        const readLo = this.readByte();
        const readHi = this.inc(1).readByte();

        return new Address(this.cpu, readLo, readHi);
    }

    writeByte(val: byte) {
        this.cpu.write(this.hi, this.lo, val);
    }

    writeWord(val: word) {
        this.writeByte(val & 0xff);
        this.inc(1).writeByte(val >> 8);
    }

    writeAddress(val: Address) {
        this.writeByte(val.loByte());
        this.inc(1).writeByte(val.hiByte());
    }

    toString() {
        return '$' + toHex(this.hi) + toHex(this.lo);
    }
}

// ProDOS zero page locations

const COMMAND = 0x42;
const UNIT = 0x43;
const ADDRESS_LO = 0x44;
// const ADDRESS_HI = 0x45;
const BLOCK_LO = 0x46;
// const BLOCK_HI = 0x47;

// const IO_ERROR = 0x27;
const NO_DEVICE_CONNECTED = 0x28;
const WRITE_PROTECTED = 0x2B;
const DEVICE_OFFLINE = 0x2F;
// const VOLUME_DIRECTORY_NOT_FOUND = 0x45;
// const NOT_A_PRODOS_DISK = 0x52;
// const VOLUME_CONTROL_BLOCK_FULL = 0x55;
// const BAD_BUFFER_ADDRESS = 0x56;
// const DUPLICATE_VOLUME_ONLINE = 0x57;

// Type: Device
// $00: Memory Expansion Card (RAM disk)
// $01: 3.5" disk
// $02: ProFile-type hard disk
// $03: Generic SCSI
// $04: ROM disk
// $05: SCSI CD-ROM
// $06: SCSI tape or other SCSI sequential device
// $07: SCSI hard disk
const DEVICE_TYPE_SCSI_HD = 0x07;
// $08: Reserved
// $09: SCSI printer
// $0A: 5-1/4" disk
// $0B: Reserved
// $0C: Reserved
// $0D: Printer
// $0E: Clock
// $0F: Modem
export default class SmartPort implements Card, MassStorage<BlockFormat>, Restorable<SmartPortState> {

    private rom: rom;
    private disks: BlockDisk[] = [];
    private busy: boolean[] = [];
    private busyTimeout: ReturnType<typeof setTimeout>[] = [];
    private ext: DiskFormat[] = [];
    private metadata: Array<HeaderData | null> = [];

    constructor(
        private cpu: CPU6502,
        private callbacks: Callbacks | null,
        options: SmartPortOptions
    ) {
        if (options?.block) {
            const dumbPortRom = new Uint8Array(smartPortRom);
            dumbPortRom[0x07] = 0x3C;
            this.rom = dumbPortRom;
            debug('DumbPort card');
        } else {
            debug('SmartPort card');
            this.rom = smartPortRom;
        }
    }

    private debug(..._args: unknown[]) {
        // debug.apply(this, arguments);
    }

    private driveLight(driveNo: DriveNumber) {
        if (!this.busy[driveNo]) {
            this.busy[driveNo] = true;
            this.callbacks?.driveLight(driveNo, true);
        }
        clearTimeout(this.busyTimeout[driveNo]);
        this.busyTimeout[driveNo] = setTimeout(() => {
            this.busy[driveNo] = false;
            this.callbacks?.driveLight(driveNo, false);
        }, 100);
    }

    /*
     * dumpBlock
     */

    dumpBlock(driveNo: DriveNumber, block: number) {
        let result = '';
        let b;
        let jdx;

        for (let idx = 0; idx < 32; idx++) {
            result += toHex(idx << 4, 4) + ': ';
            for (jdx = 0; jdx < 16; jdx++) {
                b = this.disks[driveNo].blocks[block][idx * 16 + jdx];
                if (jdx === 8) {
                    result += ' ';
                }
                result += toHex(b) + ' ';
            }
            result += '        ';
            for (jdx = 0; jdx < 16; jdx++) {
                b = this.disks[driveNo].blocks[block][idx * 16 + jdx] & 0x7f;
                if (jdx === 8) {
                    result += ' ';
                }
                if (b >= 0x20 && b < 0x7f) {
                    result += String.fromCharCode(b);
                } else {
                    result += '.';
                }
            }
            result += '\n';
        }
        return result;
    }

    /*
     * getDeviceInfo
     */

    getDeviceInfo(state: CpuState, driveNo: DriveNumber) {
        if (this.disks[driveNo]) {
            const blocks = this.disks[driveNo].blocks.length;
            state.x = blocks & 0xff;
            state.y = blocks >> 8;

            state.a = 0;
            state.s &= ~flags.C;
        } else {
            state.a = NO_DEVICE_CONNECTED;
            state.s |= flags.C;
        }
    }

    /*
     * readBlock
     */

    readBlock(state: CpuState, driveNo: DriveNumber, block: number, buffer: Address) {
        this.debug(`read drive=${driveNo}`);
        this.debug(`read buffer=${buffer.toString()}`);
        this.debug(`read block=$${toHex(block)}`);

        if (!this.disks[driveNo]?.blocks.length) {
            debug('Drive', driveNo, 'is empty');
            state.a = DEVICE_OFFLINE;
            state.s |= flags.C;
            return;
        }

        // debug('read', '\n' + dumpBlock(drive, block));
        this.driveLight(driveNo);

        for (let idx = 0; idx < 512; idx++) {
            buffer.writeByte(this.disks[driveNo].blocks[block][idx]);
            buffer = buffer.inc(1);
        }

        state.a = 0;
        state.s &= ~flags.C;
    }

    /*
     * writeBlock
     */

    writeBlock(state: CpuState, driveNo: DriveNumber, block: number, buffer: Address) {
        this.debug(`write drive=${driveNo}`);
        this.debug(`write buffer=${buffer.toString()}`);
        this.debug(`write block=$${toHex(block)}`);

        if (!this.disks[driveNo]?.blocks.length) {
            debug('Drive', driveNo, 'is empty');
            state.a = DEVICE_OFFLINE;
            state.s |= flags.C;
            return;
        }

        if (this.disks[driveNo].readOnly) {
            debug('Drive', driveNo, 'is write protected');
            state.a = WRITE_PROTECTED;
            state.s |= flags.C;
            return;
        }

        // debug('write', '\n' + dumpBlock(drive, block));
        this.driveLight(driveNo);

        for (let idx = 0; idx < 512; idx++) {
            this.disks[driveNo].blocks[block][idx] = buffer.readByte();
            buffer = buffer.inc(1);
        }
        state.a = 0;
        state.s &= ~flags.C;
    }

    /*
     * formatDevice
     */

    formatDevice(state: CpuState, driveNo: DriveNumber) {
        if (!this.disks[driveNo]?.blocks.length) {
            debug('Drive', driveNo, 'is empty');
            state.a = DEVICE_OFFLINE;
            state.s |= flags.C;
            return;
        }

        if (this.disks[driveNo].readOnly) {
            debug('Drive', driveNo, 'is write protected');
            state.a = WRITE_PROTECTED;
            state.s |= flags.C;
            return;
        }

        for (let idx = 0; idx < this.disks[driveNo].blocks.length; idx++) {
            this.disks[driveNo].blocks[idx] = new Uint8Array();
            for (let jdx = 0; jdx < 512; jdx++) {
                this.disks[driveNo].blocks[idx][jdx] = 0;
            }
        }

        state.a = 0;
        state.s &= flags.C;
    }

    private access(off: byte, val: byte) {
        let result;
        const readMode = val === undefined;

        switch (off & 0x8f) {
            case 0x80:
                if (readMode) {
                    result = 0;
                    for (let idx = 0; idx < this.disks.length; idx++) {
                        result <<= 1;
                        if (this.disks[idx]) {
                            result |= 0x01;
                        }
                    }
                }
                break;
        }

        return result;
    }

    /*
     * Interface
     */

    ioSwitch(off: byte, val: byte) {
        return this.access(off, val);
    }

    read(_page: byte, off: byte) {
        const state = this.cpu.getState();
        let cmd;
        let unit;
        let buffer;
        let block;
        const blockOff = this.rom[0xff];
        const smartOff = blockOff + 3;

        if (off === blockOff && this.cpu.getSync()) { // Regular block device entry POINT
            this.debug('block device entry');
            cmd = this.cpu.read(0x00, COMMAND);
            unit = this.cpu.read(0x00, UNIT);
            const bufferAddr = new Address(this.cpu, ADDRESS_LO);
            const blockAddr = new Address(this.cpu, BLOCK_LO);
            const drive = (unit & 0x80) ? 2 : 1;
            const driveSlot = (unit & 0x70) >> 4;

            buffer = bufferAddr.readAddress();
            block = blockAddr.readWord();

            this.debug(`cmd=${cmd}`);
            this.debug('unit=$' + toHex(unit));

            this.debug(`slot=${driveSlot} drive=${drive}`);
            this.debug(`buffer=${buffer.toString()} block=$${toHex(block)}`);

            switch (cmd) {
                case 0: // INFO
                    this.getDeviceInfo(state, drive);
                    break;

                case 1: // READ
                    this.readBlock(state, drive, block, buffer);
                    break;

                case 2: // WRITE
                    this.writeBlock(state, drive, block, buffer);
                    break;

                case 3: // FORMAT
                    this.formatDevice(state, drive);
                    break;
            }
        } else if (off === smartOff && this.cpu.getSync()) {
            this.debug('smartport entry');
            const stackAddr = new Address(this.cpu, state.sp + 1, 0x01);
            let blocks;

            const retVal = stackAddr.readAddress();

            this.debug(`return=${retVal.toString()}`);

            const cmdBlockAddr = retVal.inc(1);
            cmd = cmdBlockAddr.readByte();
            const cmdListAddr = cmdBlockAddr.inc(1).readAddress();

            this.debug(`cmd=${cmd}`);
            this.debug(`cmdListAddr=${cmdListAddr.toString()}`);

            stackAddr.writeAddress(retVal.inc(3));

            const parameterCount = cmdListAddr.readByte();
            unit = cmdListAddr.inc(1).readByte();
            const drive = unit ? 2 : 1;
            buffer = cmdListAddr.inc(2).readAddress();
            let status;

            this.debug(`parameterCount=${parameterCount}`);
            switch (cmd) {
                case 0x00: // INFO
                    status = cmdListAddr.inc(4).readByte();
                    this.debug(`info unit=${unit}`);
                    this.debug(`info buffer=${buffer.toString()}`);
                    this.debug(`info status=${status}`);
                    switch (unit) {
                        case 0:
                            switch (status) {
                                case 0:
                                    buffer.writeByte(2); // two devices
                                    buffer.inc(1).writeByte(1 << 6); // no interrupts
                                    buffer.inc(2).writeByte(0x2); // Other vendor
                                    buffer.inc(3).writeByte(0x0); // Other vendor
                                    buffer.inc(4).writeByte(0); // reserved
                                    buffer.inc(5).writeByte(0); // reserved
                                    buffer.inc(6).writeByte(0); // reserved
                                    buffer.inc(7).writeByte(0); // reserved
                                    state.x = 8;
                                    state.y = 0;
                                    state.a = 0;
                                    state.s &= ~flags.C;
                                    break;
                            }
                            break;
                        default: // Unit 1
                            switch (status) {
                                case 0:
                                    blocks = this.disks[unit]?.blocks.length ?? 0;
                                    buffer.writeByte(0xf0); // W/R Block device in drive
                                    buffer.inc(1).writeByte(blocks & 0xff); // 1600 blocks
                                    buffer.inc(2).writeByte((blocks & 0xff00) >> 8);
                                    buffer.inc(3).writeByte((blocks & 0xff0000) >> 16);
                                    state.x = 4;
                                    state.y = 0;
                                    state.a = 0;
                                    state.s &= ~flags.C;
                                    break;
                                case 3:
                                    blocks = this.disks[unit]?.blocks.length ?? 0;
                                    buffer.writeByte(0xf0); // W/R Block device in drive
                                    buffer.inc(1).writeByte(blocks & 0xff); // Blocks low byte
                                    buffer.inc(2).writeByte((blocks & 0xff00) >> 8); // Blocks middle byte
                                    buffer.inc(3).writeByte((blocks & 0xff0000) >> 16); // Blocks high byte
                                    buffer.inc(4).writeByte(ID.length); // Vendor ID length
                                    for (let idx = 0; idx < ID.length; idx++) { // Vendor ID
                                        buffer.inc(5 + idx).writeByte(ID.charCodeAt(idx));
                                    }
                                    buffer.inc(21).writeByte(DEVICE_TYPE_SCSI_HD); // Device Type
                                    buffer.inc(22).writeByte(0x0); // Device Subtype
                                    buffer.inc(23).writeWord(0x0101); // Version
                                    state.x = 24;
                                    state.y = 0;
                                    state.a = 0;
                                    state.s &= ~flags.C;
                                    break;
                            }
                            break;
                    }
                    state.a = 0;
                    state.s &= ~flags.C;
                    break;

                case 0x01: // READ BLOCK
                    block = cmdListAddr.inc(4).readWord();
                    this.readBlock(state, drive, block, buffer);
                    break;

                case 0x02: // WRITE BLOCK
                    block = cmdListAddr.inc(4).readWord();
                    this.writeBlock(state, drive, block, buffer);
                    break;

                case 0x03: // FORMAT
                    this.formatDevice(state, drive);
                    break;

                case 0x04: // CONTROL
                    break;

                case 0x05: // INIT
                    break;

                case 0x06: // OPEN
                    break;

                case 0x07: // CLOSE
                    break;

                case 0x08: // READ
                    break;

                case 0x09: // WRITE
                    break;
            }
        }

        this.cpu.setState(state);

        return this.rom[off];
    }

    write() {
        // not writable
    }

    getState() {
        return {
            disks: this.disks.map(
                (disk) => {
                    const result: BlockDisk = {
                        blocks: disk.blocks.map(
                            (block) => new Uint8Array(block)
                        ),
                        encoding: ENCODING_BLOCK,
                        format: disk.format,
                        readOnly: disk.readOnly,
                        metadata: { ...disk.metadata },
                    };
                    return result;
                }
            )
        };
    }

    setState(state: SmartPortState) {
        this.disks = state.disks.map(
            (disk) => {
                const result: BlockDisk = {
                    blocks: disk.blocks.map(
                        (block) => new Uint8Array(block)
                    ),
                    encoding: ENCODING_BLOCK,
                    format: disk.format,
                    readOnly: disk.readOnly,
                    metadata: { ...disk.metadata },
                };
                return result;
            }
        );
    }

    setBinary(driveNo: DriveNumber, name: string, fmt: BlockFormat, rawData: ArrayBuffer) {
        let volume = 254;
        let readOnly = false;
        if (fmt === '2mg') {
            const header = read2MGHeader(rawData);
            this.metadata[driveNo] = header;
            const { bytes, offset } = header;
            volume = header.volume;
            readOnly = header.readOnly;
            rawData = rawData.slice(offset, offset + bytes);
        } else {
            this.metadata[driveNo] = null;
        }
        const options = {
            rawData,
            name,
            readOnly,
            volume,
        };

        this.ext[driveNo] = fmt;
        this.disks[driveNo] = createBlockDisk(fmt, options);
        this.callbacks?.label(driveNo, name);

        return true;
    }

    getBinary(drive: number): MassStorageData | null {
        if (!this.disks[drive]) {
            return null;
        }
        const disk = this.disks[drive];
        const ext = this.ext[drive];
        const { readOnly } = disk;
        const { name } = disk.metadata;
        let data: ArrayBuffer;
        if (ext === '2mg') {
            data = create2MGFromBlockDisk(this.metadata[drive], disk);
        } else {
            const { blocks } = disk;
            const byteArray = new Uint8Array(blocks.length * 512);
            for (let idx = 0; idx < blocks.length; idx++) {
                byteArray.set(blocks[idx], idx * 512);
            }
            data = byteArray.buffer;
        }
        return {
            metadata: { name },
            ext,
            data,
            readOnly,
        };
    }
}
