import { net, app, BrowserWindow, ipcMain, protocol, dialog, shell, FileFilter } from 'electron';
import { importKeys } from 'networkwm-js';
import path from 'path';
import { pathToFileURL } from 'url';
import os from 'os';
import fs from 'fs';
import { EWMDHiMD, EWMDNetMD } from './wmd/translations';
import { Codec, NetMDFactoryService } from './wmd/original/services/interfaces/netmd';
import fetch from 'node-fetch';
import Store from 'electron-store';
import { Connection, startServer } from './macos/server-bootstrap';
import { spawn } from 'child_process';
import { NetworkWMService } from './wmd/networkwm-service';
import contextMenu from 'electron-context-menu';
import prompt from 'electron-prompt';
import { EKBROOTS } from 'networkwm-js/dist/encryption';
import { Mutex } from 'async-mutex';
import { WebUSBInterop } from './wusb-interop';

const getOfRenderer = (...p: string[]) => path.join(__dirname, '..', 'renderer', ...p);

async function ewmdOpenDialog(window: BrowserWindow, filters: FileFilter[], directory?: boolean){
    const res = await dialog.showOpenDialog(window, { filters, properties: [directory ? 'openDirectory' : 'openFile'] });
    if(res.canceled) return null;
    else return res.filePaths[0];
}

function reload(window: BrowserWindow){
    // AppImages do not restart correctly
    if (app.isPackaged && process.env.APPIMAGE) {
        dialog.showMessageBoxSync(window, { message: "This is an AppImage. Electron has a bug where AppImages cannot restart. Please restart the app manually" });
    }
    app.relaunch();
    app.exit();
}

function openExternalLink(url: string) {
    if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
    }
}

export interface Setting {
    name: string;
    family: string;
    type: 'boolean' | 'string' | 'number' | 'action' | 'hostFilePath' | 'hostDirPath';
    state: boolean | string | number;
}

export interface SettingFunction extends Setting {
    handleChange(newValue: Setting['state']): Promise<void>;
}

function setupSettings(window: BrowserWindow) {
    const store = new Store();

    const _settings: (SettingFunction | null)[] = [
        {
            family: 'Functionality',
            name: 'Open Devtools',
            async handleChange(){
                window.webContents.openDevTools();
            },
            state: 0,
            type: 'action',
        },
        {
            family: 'Functionality',
            name: 'Use a Default Download Directory',
            async handleChange(newVal: boolean){
                if(newVal) {
                    // Enabled
                    if(!store.get('downloadPath', null)) { // Match both '' and null
                        // Ask the user for the path
                        const userProvided = await ewmdOpenDialog(window, [], true);
                        if(!userProvided) return; // If the user cancelled, do not write any changes
                        store.set('downloadPath', userProvided);
                    }
                }
                store.set('useDownloadPath', newVal);
            },
            state: store.get('useDownloadPath', false) as boolean,
            type: 'boolean',
        },
        {
            family: 'Functionality',
            name: 'Accept Invalid HTTPS Certificates',
            async handleChange(newVal: boolean){
                store.set('acceptInvalidCertificates', newVal);
            },
            state: store.get('acceptInvalidCertificates', false) as boolean,
            type: 'boolean',
        },
        store.get('useDownloadPath', false) ? {
            family: 'Functionality',
            name: 'Default Download Directory',
            async handleChange(newVal: string){
                if(!newVal && store.get('downloadPath', '')){
                    // If the user cancelled, but there's a path set already, do not do anything
                    return;
                }
                if(!newVal){
                    // The user cancelled, and there's nothing set (edge case)
                    // Disable the menu option
                    store.set('useDownloadPath', false);
                }
                store.set('downloadPath', newVal);
            },
            type: 'hostDirPath',
            state: store.get('downloadPath', '') as string,
        }: null,
        {
            family: 'Functionality',
            name: 'Import NetworkWM Keyring Data',
            type: 'action',
            state: 0,
            async handleChange() {
                const resp = await prompt({
                    title: 'Keyring Import',
                    label: 'Please enter the keyring string below',
                    inputAttrs: {
                        type: 'text',
                    }
                }, window);
                if(resp === null) return;
                let rawData;
                let backup = { ...EKBROOTS };
                Object.keys(EKBROOTS).forEach((e: any) => delete EKBROOTS[e]);
                try{
                    rawData = Uint8Array.from(atob(resp), e => e.charCodeAt(0));
                    importKeys(rawData);
                }catch(ex){
                    dialog.showMessageBoxSync(window, { message: 'Keyring import failed.' });
                    Object.keys(EKBROOTS).forEach((e: any) => EKBROOTS[e] = backup[e]); 
                    return;
                }
                fs.writeFileSync(path.join(app.getPath('userData'), 'EKBROOTS.DES'), rawData);
                reload(window);
            }
        }
    ];
    const settings = _settings.filter(e => e);

    ipcMain.removeHandler('setting_update');
    ipcMain.removeHandler('fetch_settings_list');

    ipcMain.handle("setting_update", async (_, name: string, newValue: Setting['state']) => {
        const setting = settings.find(e => e.name === name);
        if((setting as any).handleChange){
            await (setting as any).handleChange(newValue);
            setupSettings(window);
        }
    });

    ipcMain.handle("fetch_settings_list", () => {
        return settings.map(e => {
            let q = { ...e } as any;
            delete q['handleChange'];
            return q;
        });
    });
}

function setupEncoder(window: BrowserWindow) {
    const store = new Store();

    function invoke(program: string, args: string[]): Promise<number | null> {
        return new Promise<number | null>(res => {
            const name = path.basename(program);
            const process = spawn(program, args);
            process.on('error', (e) => {
                console.log(`[${name} - ERROR]: ${e}`);
                res(null);
            });
            process.on('close', (e) => res(e));
            process.stdout.on('data', e => console.log(`[${name} - STDOUT]: ${e.toString().trim()}`));
            process.stderr.on('data', e => console.log(`[${name} - STDERR]: ${e.toString().trim()}`));
        });
    }

    // The renderer runs third-party encoder plugins, so the executable it asks for
    // has to be confirmed by the user once before it is ever started.
    async function isEncoderApproved(encoderPath: string) {
        const approved = store.get('approvedLocalEncoders', []) as string[];
        if (approved.includes(encoderPath)) return true;
        const { response } = await dialog.showMessageBox(window, {
            type: 'question',
            buttons: ['Allow', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            message: 'Allow ElectronWMD to run this program as the local ATRAC encoder?',
            detail: encoderPath,
        });
        if (response !== 0) return false;
        store.set('approvedLocalEncoders', [...approved, encoderPath]);
        return true;
    }

    ipcMain.handle("invokeLocalEncoder", async (_, encoderPath: string, data: ArrayBuffer, sourceFilename: string, parameters: { format: Codec, enableReplayGain?: boolean }) => {
        if (typeof encoderPath !== 'string' || !path.isAbsolute(encoderPath) || !fs.statSync(encoderPath, { throwIfNoEntry: false })?.isFile()) {
            throw new Error('The local encoder path must point to an existing file.');
        }
        const bitrate = parameters?.format?.bitrate;
        if (!Number.isInteger(bitrate) || bitrate <= 0) {
            throw new Error('Invalid bitrate requested from the local encoder.');
        }
        if (!(await isEncoderApproved(encoderPath))) {
            throw new Error('The local encoder was not allowed to run.');
        }

        let baseDir = os.tmpdir();
        if (os.platform() === 'darwin') {
            baseDir = path.join(app.getPath('home'), 'Library', 'Caches', 'ElectronWMD');
            fs.mkdirSync(baseDir, { recursive: true });
        }
        // A fresh directory per call, so parallel encodes can't clobber each other's files
        const tempDir = fs.mkdtempSync(path.join(baseDir, 'atracenc'));
        try {
            // Only the extension of the renderer-provided name is kept - it must not be able to escape tempDir
            const inFilePath = path.join(tempDir, 'input' + path.extname(String(sourceFilename)));
            const outFilePath = path.join(tempDir, "output.wav");
            fs.writeFileSync(inFilePath, new Uint8Array(data));

            const allArgs = ['-e', '-br', bitrate.toString(), inFilePath, outFilePath];
            console.log(`Executing encoder EXE: ${encoderPath}. ARGS: ${allArgs}`);
            const exitCode = await invoke(encoderPath, allArgs);
            if (exitCode !== 0 || !fs.existsSync(outFilePath)) {
                throw new Error(`The local encoder failed (exit code: ${exitCode}).`);
            }
            return new Uint8Array(fs.readFileSync(outFilePath)).buffer;
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
}

async function createWindow() {
    const window = new BrowserWindow({
        width: 1280,
        height: 900,
        icon: path.join(__dirname, '..', 'res', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    console.log(app.getPath('exe'))

    // External pages must never load inside the app, where they would get the preload's `window.native` API
    window.webContents.setWindowOpenHandler(({ url }) => {
        openExternalLink(url);
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('sandbox://app/')) {
            event.preventDefault();
            openExternalLink(url);
        }
    });

    await integrate(window);
    window.setMenuBarVisibility(false);
    await window.loadURL('sandbox://app/index.html');
    window.setTitle('Electron WMD');

    const store = new Store();

    window.setMenuBarVisibility(false);

    window.webContents.session.on('will-download', async (event, item, contents) => {
        let downloadPath = store.get('downloadPath', '') as string;
        let useDownloadPath = store.get('useDownloadPath', false) as boolean;

        if (downloadPath && useDownloadPath) {
            const baseFilename = item.getFilename();
            let filename = path.join(downloadPath, baseFilename);
            const { name, ext } = path.parse(baseFilename);
            let i = 1;
            while(fs.existsSync(filename)){
                filename = path.join(downloadPath, `${name} (${i++})${ext}`);
            }
            item.setSavePath(filename);
        }
    });
}

function getDefinedFunctions(currentObj: any){
    const defined = new Set<string>();
    do{
        Object.getOwnPropertyNames(currentObj)
        .filter((n) => typeof currentObj[n] == 'function' && !(n in defined))
        .forEach(defined.add.bind(defined));
    } while ((currentObj = Object.getPrototypeOf(currentObj)));
    return defined;
}

function traverseObject(window: BrowserWindow, objectFactory: () => any, namespace: string) {
    let currentObj = objectFactory();
    const defined = getDefinedFunctions(currentObj);
    defined.forEach((n) => {
        const translatedName = namespace + n;
        console.log(`[INTEGRATE]: Registering handler ${translatedName}`);
        ipcMain.handle(translatedName, async function (_, ...allArgs: any[]) {
            for (let i = 0; i < allArgs.length; i++) {
                if (allArgs[i]?.interprocessType === 'function') {
                    allArgs[i] = async (...args: any[]) =>
                        {
                            window.webContents.send('_callback', `${translatedName}_callback${i}`, ...args);
                        }
                }
            }
            try {
                return [await objectFactory()[n](...allArgs), null];
            } catch (err) {
                console.log("Node Error: ");
                console.log(err);
                return [null, err];
            }
        });
    });
    return Array.from(defined).map(e => namespace + e);
}

async function integrate(window: BrowserWindow) {
    const webusb = WebUSBInterop.create();

    Object.defineProperty(global, 'navigator', {
        writable: false,
        value: { usb: webusb },
    });
    Object.defineProperty(global, 'window', {
        writable: false,
        value: global,
    });
    Object.defineProperty(global, 'alert', {
        writable: false,
        value: (text: string) => dialog.showMessageBoxSync(window, { message: text }),
    });

    const service = new EWMDNetMD({ debug: true });

    let currentObj = service as any;
    console.log(currentObj);

    const defList = traverseObject(window, () => currentObj, "_netmd_");
    ipcMain.handle('_netmd__definedParameters', () => defList);

    let alreadySwitched = false;
    let factoryIface: any = null;
    let factoryDefList: string[] = [];

    ipcMain.handle('reload', reload.bind(null, window));

    ipcMain.handle('_switchToFactory', async () => {
        factoryIface = await service.factory();
        if (alreadySwitched) return factoryDefList;
        alreadySwitched = true;

        factoryDefList = traverseObject(
            window,
            () => factoryIface,
            "_factory__"
        );


        // exploitDownloadTrack uses nested objects with callbacks, and callbacks with return values.
        // The nomral ipc-copying code can't be used for that.
        let shouldAbortAtracDownload = false;
        let handleBadSectorResolve: ((arg: "reload" | "abort" | "skip" | "yieldanyway") => void) | null = null

        ipcMain.removeHandler('_factory__exploitDownloadTrack');
        ipcMain.handle('_factory__exploitDownloadTrack', async (_, ...allArgs: Parameters<NetMDFactoryService['exploitDownloadTrack']>) => {
            handleBadSectorResolve = null;
            shouldAbortAtracDownload = false;

            const enableHandleBadSector = allArgs[3].handleBadSector;
            const enableShouldCancelImmediately = allArgs[3].handleBadSector;

            allArgs[3] = {
                ...allArgs[3],
                handleBadSector: async (...args: any[]) => {
                    window.webContents.send('_atracdl_callback_handleBadSector', ...args);
                    return await new Promise<"reload" | "abort" | "skip" | "yieldanyway">(res => handleBadSectorResolve = res);
                },
                shouldCancelImmediately: () => shouldAbortAtracDownload,
            };
            if(!enableHandleBadSector) delete allArgs[3].handleBadSector;
            if(!enableShouldCancelImmediately) delete allArgs[3].shouldCancelImmediately;
            allArgs[2] = async (...args: any[]) =>
                window.webContents.send('_callback', `_factory__exploitDownloadTrack_callback2`, ...args);

            try{
                return [await factoryIface.exploitDownloadTrack(...allArgs), null];
            }catch (err) {
                console.log("Node Error: ");
                console.log(err);
                return [null, err];
            }
        });
        ipcMain.handle('_atracdl_cancel', () => shouldAbortAtracDownload = true);
        ipcMain.handle('_atracdl_callback_handleBadSector_return', (_, status: "reload" | "abort" | "skip" | "yieldanyway") => handleBadSectorResolve?.(status));

        return factoryDefList;
    });

    const himdService = new EWMDHiMD({ debug: true });

    let keyData: Uint8Array | undefined = undefined;
    try{
        keyData = new Uint8Array(fs.readFileSync(path.join(app.getPath('userData'), 'EKBROOTS.DES')));
    }catch(_){ console.log("Can't read roots") }
    const nwService = new NetworkWMService(keyData);

    if(process.platform !== 'darwin') {
        const himdDeflist = traverseObject(window, () => himdService, "_himd_");
        ipcMain.handle('_himd__definedParameters', () => himdDeflist);
        const nwDeflist = traverseObject(window, () => nwService, "_nwjs_");
        ipcMain.handle('_nwjs__definedParameters', () => nwDeflist);    
    } else {
        const connection = new Connection();
        connection.deviceDisconnectedCallback = () => reload(window);
        const connectionMutex = new Mutex();

        connection.callbackHandler = (service, name: string, ...args: any[]) => window.webContents.send("_callback", (service === 'himd' ? '_himd_' : '_nwjs_') + name, ...args);
        const himdDefinedMethods = getDefinedFunctions(himdService);
        ipcMain.handle('_himd__definedParameters', () => [...himdDefinedMethods].map(e => '_himd_' + e));
        for(let methodName of himdDefinedMethods){
            ipcMain.handle(`_himd_${methodName}`, async (_, ...allArgs: any[]) => {
                console.log(`Execute: ${methodName}`);
                if(methodName === 'connect'){
                    let connectionEstablished = false;
                    if(connection.socket) {
                        connection.disconnect();
                    }
                    try{
                        startServer();
                    }catch(ex) {
                        return [null, ex];
                    }
                    const error = await connection.awaitConnection();
                    connectionEstablished = true;
                    if(error) {
                        return [null, error];
                    }
                }
                if(!connection.socket) {
                    return [null, new Error("Server not ready!")];
                }

                const release = await connectionMutex.acquire();
                try {
                    return [await connection.callMethod('himd', methodName, ...allArgs), null];
                } catch (err) {
                    console.log("External HIMD Error: ");
                    console.log(err);
                    return [null, err];
                } finally {
                    release();
                }
            });
        }

        const nwjsDefinedMethods = getDefinedFunctions(himdService);
        ipcMain.handle('_nwjs__definedParameters', () => [...nwjsDefinedMethods].map(e => '_nwjs_' + e));
        for(let methodName of nwjsDefinedMethods){
            ipcMain.handle(`_nwjs_${methodName}`, async (_, ...allArgs: any[]) => {
                console.log(`Execute: ${methodName}`);
                if(methodName === 'connect'){
                    let connectionEstablished = false;
                    if(connection.socket) {
                        connection.disconnect();
                    }
                    try{
                        startServer();
                    }catch(ex) {
                        return [null, ex];
                    }
                    const error = await connection.awaitConnection();
                    connectionEstablished = true;
                    if(error) {
                        return [null, error];
                    }
                }
                if(!connection.socket) {
                    return [null, new Error("Server not ready!")];
                }

                const release = await connectionMutex.acquire();
                try {
                    return [await connection.callMethod('nwjs', methodName, ...allArgs), null];
                } catch (err) {
                    console.log("External NWJS Error: ");
                    console.log(err);
                    return [null, err];
                } finally {
                    release();
                }
            });
        }
    }

    // Lets song recognition reach Shazam without CORS - the renderer must not be able to fetch anything else
    const unrestrictedFetchHosts = ['amp.shazam.com'];
    ipcMain.handle('_unrestrictedFetch', async (_: any, url: string, parameters: any) => {
        const target = new URL(url);
        if (target.protocol !== 'https:' || !unrestrictedFetchHosts.includes(target.hostname)) {
            throw new Error(`Fetching from ${target.origin} is not allowed`);
        }
        return await (await fetch(target.href, parameters)).text();
    });

    ipcMain.handle('_signHiMDDisc', () => (global as any).signHiMDDisc());
    ipcMain.handle('_signNWJS', () => (global as any).signNWJS());

    // These write to arbitrary host paths - development builds (or EWMD_DEBUG=1) only
    if (!app.isPackaged || process.env.EWMD_DEBUG) {
        ipcMain.handle('_debug_himdPullFile', async (e, a: string, b: string) => {
            console.log(`Pulling HiMD file ${a} to local ${b}`);
            const handle = await himdService.fsDriver!.fatfs!.open(a, false);
            if(!handle){
                console.log("No file!");
                return;
            }
            fs.writeFileSync(b, await handle.readAll());
            await handle.close();
        });
        ipcMain.handle('_debug_himdList', async (e, a: string) => {
            console.log(`Listing HiMD dir ${a}`);
            const list = await himdService.fsDriver!.fatfs!.listDir(a);
            if(!list){
                console.log("No such dir!");
                return;
            }
            console.log(list.join(', '));
        });
    }

    ipcMain.handle("openFileHostDialog", async (_, filters: { name: string, extensions: string[] }[], directory?: boolean): Promise<string | null> => {
        return ewmdOpenDialog(window, filters, directory);     
    });

    setupSettings(window);
    setupEncoder(window);

    // On a USB disconnect event, enumerate services, check if any was connected
    const addKnownDeviceCB = webusb.addKnownDevice.bind(webusb);
    nwService.deviceConnectedCallback = addKnownDeviceCB;
    himdService.deviceConnectedCallback = addKnownDeviceCB;
    webusb.ondisconnect = event => {
        if([service, himdService, nwService].some(e => e.isDeviceConnected(event.device))) {
            reload(window);
        }
    }
}

app.on('certificate-error', (event, _webContents, url, error, _certificate, callback) => {
    // Opt-in only, e.g. for a self-hosted remote encoder with a self-signed certificate
    if (new Store().get('acceptInvalidCertificates', false)) {
        console.log(`Accepting invalid certificate for ${url} (${error})`);
        event.preventDefault();
        callback(true);
    }
});

contextMenu({
    showInspectElement: false,
});
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sandbox',
    privileges: {
      standard: true,
      secure: true,
      corsEnabled: true,
      supportFetchAPI: true
    }
  }
]);
app.whenReady().then(() => {
    const rendererRoot = getOfRenderer();
    protocol.handle('sandbox', (rq) => {
        // Decode before checking, so that an encoded '..' can't escape the renderer directory either
        let tgt: string;
        try {
            tgt = path.resolve(rendererRoot, '.' + decodeURIComponent(new URL(rq.url).pathname));
        } catch (_) {
            return new Response(null, { status: 400 });
        }
        if (!tgt.startsWith(rendererRoot + path.sep)) {
            console.log(`[SANDBOX]: Refused ${rq.url}`);
            return new Response(null, { status: 403 });
        }
        console.log(`[SANDBOX]: Requested ${tgt}`);
        return net.fetch(pathToFileURL(tgt).toString());
    });
    createWindow();
});
