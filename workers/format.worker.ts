import { debug } from '../js/util';
import { jsonDecode } from '../js/formats/format_utils';
import {
    createDisk,
    createDiskFromJsonDisk,
} from '../js/formats/create_disk';
import {
    FormatWorkerMessage,
    DiskProcessedResponse,
    DISK_PROCESSED,
    PROCESS_BINARY,
    PROCESS_JSON_DISK,
    PROCESS_JSON,
    FloppyDisk,
} from '../js/formats/types';

debug('Worker loaded');

addEventListener('message', (message: MessageEvent<FormatWorkerMessage>) => {
    debug('Worker started', message.type);
    const data = message.data;
    const { driveNo } = data.payload;
    let disk: FloppyDisk | null = null;

    switch (data.type) {
        case PROCESS_BINARY: {
            const { fmt, options } = data.payload;
            disk = createDisk(fmt, options);
        }
            break;

        case PROCESS_JSON_DISK: {
            const { jsonDisk } = data.payload;
            disk = createDiskFromJsonDisk(jsonDisk);
        }
            break;

        case PROCESS_JSON: {
            const { json } = data.payload;
            disk = jsonDecode(json);
        }
            break;
    }

    const response: DiskProcessedResponse = {
        type: DISK_PROCESSED,
        payload: {
            driveNo,
            disk
        }
    };

    self.postMessage(response);

    debug('Worker complete', message.type);
});
