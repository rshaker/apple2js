import { DiskOptions, BlockDisk, ENCODING_BLOCK, BlockFormat } from './types';

/**
 * Returns a `Disk` object for a block volume with block-ordered data.
 * @param options the disk image and options
 */
export default function createBlockDisk(fmt: BlockFormat, options: DiskOptions): BlockDisk {
    const { rawData, readOnly, name } = options;

    if (!rawData) {
        throw new Error('Requires rawData');
    }

    const blocks = [];
    let offset = 0;
    while (offset  < rawData.byteLength) {
        blocks.push(new Uint8Array(rawData.slice(offset, offset + 0x200)));
        offset += 0x200;
    }

    const disk: BlockDisk = {
        encoding: ENCODING_BLOCK,
        format: fmt,
        blocks,
        metadata: { name },
        readOnly,
    };

    return disk;
}
