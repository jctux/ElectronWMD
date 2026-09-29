import fs from 'fs';
import { EWMDHiMD } from '../wmd/translations';
import { createServer } from 'net';
import { PackrStream, UnpackrStream } from 'msgpackr';
import path from 'path';
import { NetworkWMService } from '../wmd/networkwm-service';
import { WebUSBInterop } from '../wusb-interop';
import { getPidPath, getSocketDir, getSocketPath } from './socket-path';

const socketName = getSocketPath();
const pidFile = getPidPath();
const workDir = getSocketDir();
const canFail = (func: () => void) => {
    try{ func() } catch(_){}
}

const envId = (name: string) => isFinite(process.env[name] as any) ? parseInt(process.env[name]) : null;
const originalUid = envId('ORIGINAL_UID') ?? envId('SUDO_UID');
const originalGid = envId('ORIGINAL_GID') ?? envId('SUDO_GID');

// This process runs as root, so the directory holding its PID file and socket must not be writable
// by anyone else - otherwise they could plant a symlink or a fake PID file there.
function ensureSafeWorkDir(){
    fs.mkdirSync(workDir, { recursive: true, mode: 0o755 });
    const stat = fs.lstatSync(workDir);
    const ownerOk = stat.uid === process.getuid!() || stat.uid === originalUid;
    if(!stat.isDirectory() || !ownerOk || (stat.mode & 0o022)) {
        throw new Error(`Refusing to use ${workDir}: it must be a directory owned by root or the current user, and not writable by others`);
    }
}

function closeAll(){
    canFail(() => fs.unlinkSync(socketName));
    canFail(() => fs.unlinkSync(pidFile));
    process.exit();
}
function main() {
    console.log("ElectronWMD's MacOS SCSI intermediate server by asivery");
    console.log("Starting up...");
    console.log(`Base dir: ${workDir}`);
    console.log(`Socket path: ${socketName}`);
    console.log(`PID file: ${pidFile}`);
    try {
        ensureSafeWorkDir();
    } catch(ex) {
        console.error(String(ex));
        process.exit(1);
    }
    if(fs.existsSync(pidFile)) {
        const oldPid = parseInt(fs.readFileSync(pidFile).toString());
        if(Number.isInteger(oldPid) && oldPid > 1) {
            canFail(() => process.kill(oldPid, 'SIGTERM'));
        }
        canFail(() => fs.unlinkSync(pidFile));
    }

    // O_EXCL | O_NOFOLLOW: never write through something that appeared at this path in the meantime
    const pidFd = fs.openSync(pidFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    fs.writeSync(pidFd, `${process.pid}`);
    fs.closeSync(pidFd);
    const webusb = WebUSBInterop.create();

    Object.defineProperty(global, 'navigator', {
        writable: false,
        value: { usb: webusb },
    });
    Object.defineProperty(global, 'window', {
        writable: false,
        value: global,
    });

    canFail(() => fs.unlinkSync(socketName));

    const server = createServer();
    server.on('error', (err) => {
        console.error('Server error:', err);
        closeAll();
    });
    server.listen(socketName, () => {
        console.log(`Server listening on socket: ${socketName}`);
        try {
            if (originalUid !== null && originalGid !== null) {
                try { fs.chownSync(socketName, originalUid, originalGid); } catch (_) {}
                try { fs.chmodSync(socketName, 0o600); } catch (_) {}
                console.log(`Socket ownership set to ${originalUid}:${originalGid ?? 0} and mode 0600`);
            } else {
                // Never 0777 - that would let any local user drive a root process
                fs.chmodSync(socketName, 0o600);
                console.log('Original user unknown - socket left owned by the current user with mode 0600');
            }
        } catch (err) {
            console.error('Failed setting socket ownership/permissions:', err);
        }
    });
    server.on("close", closeAll);
    server.on('connection', (socket) => {
        console.log("Connection established.");
        socket.on('close', closeAll);
        const packerStream = new PackrStream({
            copyBuffers: true,
            structuredClone: true,
        });
        const unpackerStream = new UnpackrStream({
            copyBuffers: true,
            structuredClone: true,
        });

        const himdDevice = new EWMDHiMD({ debug: true });

        let keyData: Uint8Array | undefined = undefined;
        try{
            keyData = new Uint8Array(fs.readFileSync(path.join(process.argv[2], 'EKBROOTS.DES')));
        }catch(_){ console.log("Can't read roots") }
        const nwDevice = new NetworkWMService(keyData);

        socket.pipe(unpackerStream);
        packerStream.pipe(socket);

        function sendCallback(service: string, callbackFunctionName: string, ...args: any[]){
            packerStream.write({
                type: 'callback',
                name: callbackFunctionName,
                service,
                value: args,
            })
        }

        unpackerStream.on('data', async ({ service, name, allArgs }: { service: string, name: string, allArgs: any[] }) => {
            console.log(`Call to ${name}`);
            for (let i = 0; i < allArgs.length; i++) {
                if (allArgs[i]?.interprocessType === 'function') {
                    allArgs[i] = async (...args: any[]) =>
                        {
                            sendCallback(service, `${name}_callback${i}`, ...args);
                        }
                }
            }
            let res;
            try {
                const serviceObject = service === 'nwjs' ? nwDevice : himdDevice;
                res = [await (serviceObject as any)[name](...allArgs), null];
            } catch (err) {
                console.log("Node Error: ");
                console.log(err);
                res = [null, err];
            }

            packerStream.write({
                type: 'return',
                name,
                value: res,
            });
        })

        const addKnownDeviceCB = webusb.addKnownDevice.bind(webusb);
        nwDevice.deviceConnectedCallback = addKnownDeviceCB;
        himdDevice.deviceConnectedCallback = addKnownDeviceCB;
        webusb.ondisconnect = event => {
            if([nwDevice, himdDevice].some(e => e.isDeviceConnected(event.device))) {
                closeAll();
            }
        }
    });
}

main()
