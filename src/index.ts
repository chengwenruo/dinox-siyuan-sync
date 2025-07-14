import {
    Plugin,
    showMessage,
    confirm,
    Menu,
    getFrontend,
    IModel,
    ICard,
    ICardData,
} from "siyuan";
import "@/index.scss";

import {SettingUtils} from "./libs/setting-utils";
import axios from "axios";
import {
    createDocWithMd,
    exportMdContent,
    getBlockByID,
    getIDsByHPath,
    getPathByID,
    removeDoc,
    setBlockAttrs,
    getBlockAttrs
} from "@/api";

const STORAGE_NAME = "dinox_sync";

// --- Interfaces ---
interface Note {
    title: string;
    createTime: string;
    content: string;
    noteId: string;
    tags: string[];
    isDel: boolean;
    isAudio?: boolean;
    type: string;
    zettelBoxes?: string[];
}

interface DayNote {
    date: string;
    notes: Note[];
}

interface GetNoteApiResult {
    code: string;
    msg?: string;
    data: DayNote[];
}

interface DinoPluginSettings {
    token: string;
    isAutoSync: boolean;
    notebookId: string;
    filenameFormat: "noteId" | "title" | "time";
    fileLayout: "flat" | "nested";
    ignoreSyncKey: string;
    preserveKeys: string;
}

// --- Constants ---
const DEFAULT_SETTINGS: DinoPluginSettings = {
    token: "",
    isAutoSync: false,
    notebookId: "",
    filenameFormat: "noteId",
    fileLayout: "nested",
    ignoreSyncKey: "ignore_sync",
    preserveKeys: "",
};

const API_BASE_URL = "https://dinoai.chatgo.pro";
const API_BASE_URL_AI = "https://aisdk.chatgo.pro";

function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Keep sanitization for robustness
function sanitizeFilename(name: string): string {
    if (!name) return "Untitled";
    let sanitized = name.replace(/[\\/:*?"<>|#^\[\]]/g, "-");
    sanitized = sanitized.replace(/[\s-]+/g, "-");
    sanitized = sanitized.trim().replace(/^-+|-+$/g, "");
    sanitized = sanitized.substring(0, 100);
    if (sanitized === "." || sanitized === "..") return "Untitled";
    return sanitized || "Untitled";
}



interface ICallout {
    id: string;
    icon: string;
    title?: string;

    bg?: {
        light: string;
        dark: string;
    };
    box?: {
        light: string;
        dark: string;
    };

    hide?: boolean;
    // order?: number;
    custom?: boolean;
    slash?: {
        big?: boolean;
        small?: boolean;
    }
}

function createCalloutButton(selectid: BlockId, callout: ICallout): HTMLButtonElement{
    let button = document.createElement("button")
    // let title = callout.title;
    button.className = "b3-menu__item"
    button.setAttribute("data-node-id", selectid)
    let name =  'b';
    button.setAttribute("custom-attr-name", name)
    button.setAttribute("custom-attr-value", callout.id);
    button.innerHTML = `<span class="b3-menu__label">${callout.icon}${"点击"}</span>`
    return button
}



export default class PluginSample extends Plugin {
    private blockIconEventBindThis = this.blockIconEvent.bind(this);
    private isSyncing: boolean = false;
    private settings: DinoPluginSettings;

    private async blockIconEvent({ detail }: any) {
        let menu: Menu = detail.menu;
        const root = detail.blockElements[0]
        const selectid = root.getAttribute("data-node-id") as string

        menu.addItem({
            icon: "iconInfo",
            label: "同步到 Dinox",
            click: async () => {
                await this.syncCurrentBlockToDinox(selectid);
            }
        });

        menu.addItem({
            icon: "iconUpload", 
            label: "创建到 Dinox",
            click: async () => {
                await this.createCurrentBlockToDinox(selectid);
            }
        });
    }

    private async syncCurrentBlockToDinox(blockId: string) {
        try {
            const block = await getBlockByID(blockId);
            console.log(block);

            const rootId = block.root_id;
            
            // 从 block attributes 中获取 noteId
            const attrs = await getBlockAttrs(rootId);
            const noteId = attrs["custom-dinox-note-id"];
            
            if (!noteId) {
                showMessage("未找到 noteId，请先创建到 Dinox", 3000, "error");
                return;
            }

            // 导出文档内容（不包含属性，只有正文）
            const result = await exportMdContent(rootId);
            const content = result.content;

            const response = await axios.post(`${API_BASE_URL_AI}/api/openapi/updateNote`, {
                noteId: noteId,
                contentMd: content
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.settingUtils.get("token")
                }
            });

            if (response.status === 200 && response.data.code === "000000") {
                showMessage("同步到 Dinox 成功", 3000, "info");
            } else {
                showMessage("同步失败：" + (response.data.msg || "未知错误"), 3000, "error");
            }
        } catch (error) {
            console.error("同步失败：", error);
            showMessage("同步失败：" + error.message, 3000, "error");
        }
    }

    private async createCurrentBlockToDinox(blockId: string) {
        try {
            const block = await getBlockByID(blockId);
            const rootId = block.root_id;
            
            // 导出文档内容（只包含正文）
            const result = await exportMdContent(rootId);
            const content = result.content;

            // 使用文档标题作为笔记标题
            const title = block.content || "新建笔记";

            const response = await axios.post(`${API_BASE_URL_AI}/api/openapi/createNote`, {
                content: content,
                title: title,
                tags: []
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.settingUtils.get("token")
                }
            });

            if (response.status === 200 && response.data.code === "000000") {
                const noteId = response.data.data.noteId;
                
                // 设置 block attributes 存储 noteId 和其他元数据
                const attrs: { [key: string]: string } = {
                    "custom-dinox-note-id": noteId,
                    "custom-dinox-title": response.data.data.title || noteId,
                    "custom-dinox-create-time": new Date().toISOString(),
                    "custom-dinox-type": "note"
                };

                await setBlockAttrs(rootId, attrs);
                
                showMessage("创建到 Dinox 成功，noteId: " + noteId.substring(0, 8) + "...", 3000, "info");
            } else {
                showMessage("创建失败：" + (response.data.msg || "未知错误"), 3000, "error");
            }
        } catch (error) {
            console.error("创建失败：", error);
            showMessage("创建失败：" + error.message, 3000, "error");
        }
    }


    customTab: () => IModel;
    private isMobile: boolean;
    private settingUtils: SettingUtils;

    async loadSettings() {
        const loadedData = await this.loadData(STORAGE_NAME) || {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
        
        // 确保所有必需的字段都有默认值
        if (!this.settings.ignoreSyncKey) {
            this.settings.ignoreSyncKey = DEFAULT_SETTINGS.ignoreSyncKey;
        }
        if (this.settings.preserveKeys === undefined) {
            this.settings.preserveKeys = DEFAULT_SETTINGS.preserveKeys;
        }
    }

    async saveSettings() {
        await this.saveData(STORAGE_NAME, this.settings);
    }

    async onload() {
        await this.loadSettings();
        
        console.log("loading Dinox sync plugin", this.i18n);
        this.eventBus.on("click-blockicon", async (event) => {
            await this.blockIconEventBindThis(event);
        });

        const frontEnd = getFrontend();
        this.isMobile = frontEnd === "mobile" || frontEnd === "browser-mobile";
        // 图标的制作参见帮助文档
        this.addIcons(`<symbol id="iconD" viewBox="0 0 28 28">
  <path d="M10 4h8a8 8 0 0 1 0 16h-8v-16zM12 6v12h6a6 6 0 0 0 0-12h-6z"/>
</symbol>`);

        const topBarElement = this.addTopBar({
            icon: "iconD",
            title: "Dinox 同步",
            position: "right",
            callback: () => {
                if (this.isMobile) {
                    this.addMenu();
                } else {
                    let rect = topBarElement.getBoundingClientRect();
                    // 如果被隐藏，则使用更多按钮
                    if (rect.width === 0) {
                        rect = document.querySelector("#barMore").getBoundingClientRect();
                    }
                    if (rect.width === 0) {
                        rect = document.querySelector("#barPlugins").getBoundingClientRect();
                    }
                    this.addMenu(rect);
                }
            }
        });

        const statusIconTemp = document.createElement("template");
        statusIconTemp.innerHTML = `<div class="toolbar__item ariaLabel" aria-label="Remove plugin-sample Data">
    <svg>
        <use xlink:href="#iconTrashcan"></use>
    </svg>
</div>`;
        statusIconTemp.content.firstElementChild.addEventListener("click", () => {
            confirm("⚠️", this.i18n.confirmRemove.replace("${name}", this.name), () => {
                this.removeData(STORAGE_NAME).then(() => {
                    this.data[STORAGE_NAME] = {readonlyText: "Readonly"};
                    showMessage(`[${this.name}]: ${this.i18n.removedData}`);
                });
            });
        });
        this.addStatusBar({
            element: statusIconTemp.content.firstElementChild as HTMLElement,
        });

        this.addCommand({
            langKey: "syncNotes",
            hotkey: "⌘+⇧+D",
            callback: () => {
                this.fetchData();
            }
        });

        this.addCommand({
            langKey: "resetSync",
            hotkey: "⌘+⇧+R",
            callback: () => {
                confirm("⚠️", "确定要重置同步状态吗？下次同步将获取所有笔记。", async () => {
                    await this.saveData("sync_data.json", {
                        lastSyncTime: "1900-01-01 00:00:00"
                    });
                    showMessage("同步状态已重置！", 3000, "info");
                });
            }
        });

        // 编辑器标题栏右键菜单事件
        this.eventBus.on("click-editortitleicon", () => {
            console.log("编辑器标题栏菜单点击");
        });

        this.settingUtils = new SettingUtils({
            plugin: this, name: STORAGE_NAME
        });
        this.settingUtils.addItem({
            key: "notebookId",
            value: this.settings.notebookId,
            type: "textinput",
            title: "NotebookID",
            description: "你想要同步的笔记本编号",
            action: {
                callback: async () => {
                    const value = await this.settingUtils.takeAndSave("notebookId");
                    this.settings.notebookId = value;
                    await this.saveSettings();
                }
            }
        });

        this.settingUtils.addItem({
            key: "token",
            value: this.settings.token,
            type: "textinput",
            title: "Dinox Token",
            description: "输入 Dinox Token",
            action: {
                callback: async () => {
                    const value = await this.settingUtils.takeAndSave("token");
                    this.settings.token = value;
                    await this.saveSettings();
                }
            }
        });



        this.settingUtils.addItem({
            key: "filenameFormat",
            value: this.settings.filenameFormat,
            type: "select",
            title: "文件名格式",
            description: "选择同步的笔记文件的命名格式",
            options: {
                noteId: "笔记 ID（推荐）",
                title: "笔记标题",
                time: "创建时间"
            },
            action: {
                callback: async () => {
                    const value = await this.settingUtils.takeAndSave("filenameFormat");
                    this.settings.filenameFormat = value as "noteId" | "title" | "time";
                    await this.saveSettings();
                }
            }
        });

        this.settingUtils.addItem({
            key: "fileLayout",
            value: this.settings.fileLayout,
            type: "select",
            title: "文件布局",
            description: "选择同步笔记的组织方式",
            options: {
                nested: "嵌套（按日期分组）",
                flat: "平铺（所有文件在同一级）"
            },
            action: {
                callback: async () => {
                    const value = await this.settingUtils.takeAndSave("fileLayout");
                    this.settings.fileLayout = value as "flat" | "nested";
                    await this.saveSettings();
                }
            }
        });

        this.settingUtils.addItem({
            key: "isAutoSync",
            value: this.settings.isAutoSync,
            type: "checkbox",
            title: "自动同步",
            description: "启用后将每 30 分钟自动同步一次",
            action: {
                callback: async () => {
                    const value = await this.settingUtils.takeAndSave("isAutoSync");
                    this.settings.isAutoSync = value;
                    await this.saveSettings();
                }
            }
        });

        // 添加同步状态显示
        this.settingUtils.addItem({
            key: "syncStatus",
            value: "",
            type: "hint",
            title: "同步状态",
            description: "显示当前的同步状态信息",
            createElement: (currentVal: any) => {
                const hintElement = document.createElement('div');
                hintElement.className = 'b3-label fn__flex-center';
                
                // 初始显示加载状态，然后异步更新
                hintElement.innerHTML = '<div style="color: #999;">正在加载同步状态...</div>';
                
                // 异步加载同步状态
                this.updateSyncStatusElement(hintElement);
                
                return hintElement;
            }
        });

        // 添加重置同步时间按钮
        this.settingUtils.addItem({
            key: "resetSyncTime",
            value: "",
            type: "button",
            title: "重置同步状态",
            description: "清除上次同步时间，下次同步将获取所有笔记",
            button: {
                label: "重置同步时间",
                callback: async () => {
                    await this.resetSyncTime();
                    // 重置后刷新同步状态显示
                    this.refreshSyncStatus();
                }
            }
        });


        try {
            this.settingUtils.load();
        } catch (error) {
            console.error("Error loading settings storage, probably empty config json:", error);
        }



    }

    onLayoutReady() {
        this.settingUtils.load();
        
        // 启动自动同步（如果启用）
        if (this.settings.isAutoSync) {
            this.startAutoSync();
        }
    }

    private startAutoSync() {
        // 每 30 分钟自动同步一次
        setInterval(async () => {
            if (!this.isSyncing) {
                console.log("Dinox: 触发自动同步...");
                try {
                    await this.fetchData();
                } catch (error) {
                    console.error("Dinox: 自动同步失败：", error);
                }
            } else {
                console.log("Dinox: 自动同步跳过，同步已在进行中");
            }
        }, 30 * 60 * 1000); // 30 分钟
    }

    private async resetSyncTime() {
        // 参照 Obsidian 插件的逻辑，添加确认对话框
        confirm("⚠️", "确定要重置同步状态吗？下次同步将获取所有笔记。", async () => {
            try {
                // 重置同步时间为默认值，与 Obsidian 插件保持一致
                const pData = await this.loadData("sync_data.json") || {};
                await this.saveData("sync_data.json", {
                    ...pData,
                    lastSyncTime: "1900-01-01 00:00:00", // 使用原始的重置值
                });
                
                showMessage("同步状态已重置！下次同步将获取所有笔记。", 5000, "info");
                console.log("Dinox: 同步时间已重置");
            } catch (error) {
                console.error("Dinox: 重置同步时间失败：", error);
                showMessage("重置同步状态失败：" + error.message, 5000, "error");
            }
        });
    }

    private async updateSyncStatusElement(hintElement: HTMLElement) {
        try {
            const pData = await this.loadData("sync_data.json") || {};
            const lastSyncTime = pData.lastSyncTime || "从未同步";
            const isFirstSync = lastSyncTime === "1900-01-01 00:00:00";
            
            hintElement.innerHTML = `
                <div style="text-align: left; width: 100%;">
                    <div>上次同步时间：<strong>${isFirstSync ? "从未同步" : lastSyncTime}</strong></div>
                    <div style="margin-top: 4px; color: #666; font-size: 12px;">
                        ${isFirstSync ? "下次同步将获取所有笔记" : "下次同步将获取增量更新"}
                    </div>
                </div>
            `;
        } catch (error) {
            hintElement.innerHTML = '<div style="color: #f56565;">无法读取同步状态</div>';
        }
    }

    private refreshSyncStatus() {
        // 重新获取并更新同步状态显示元素
        const statusElement = this.settingUtils.getElement("syncStatus");
        if (statusElement) {
            this.updateSyncStatusElement(statusElement);
        }
    }

    async onunload() {
        console.log(this.i18n.byePlugin);
        showMessage("Goodbye SiYuan Plugin");
        console.log("onunload");
    }

    uninstall() {
        console.log("uninstall");
    }

    async updateCards(options: ICardData) {
        options.cards.sort((a: ICard, b: ICard) => {
            if (a.blockID < b.blockID) {
                return -1;
            }
            if (a.blockID > b.blockID) {
                return 1;
            }
            return 0;
        });
        return options;
    }


    private async fetchData() {
        if (this.isSyncing) {
            showMessage("同步已在进行中，请勿重复操作", 3000, "info");
            return;
        }

        if (!this.settings.token) {
            showMessage("Token 不能为空，请在设置中配置", 3000, "error");
            return;
        }

        if (!this.settings.notebookId) {
            showMessage("NotebookID 不能为空，请在设置中配置", 3000, "error");
            return;
        }

        this.isSyncing = true;
        showMessage("开始同步，请勿重复操作", 0, "info");
        
        const syncStartTime = new Date();
        let processedCount = 0;
        let deletedCount = 0;
        let errorOccurred = false;

        try {
            console.log("Dinox: 同步开始");

            // 1. 获取上次同步时间
            const pData = await this.loadData("sync_data.json") || {};
            let lastSyncTime = "1900-01-01 00:00:00";
            if (pData.lastSyncTime && pData.lastSyncTime !== "") {
                try {
                    const lTime = new Date(pData.lastSyncTime);
                    lastSyncTime = formatDate(lTime);
                } catch (e) {
                    console.warn("无效的上次同步时间，使用默认时间", pData.lastSyncTime);
                    lastSyncTime = "1900-01-01 00:00:00";
                }
            }
            console.log("上次同步时间：", lastSyncTime);

            // 2. 从 API 获取数据
            const dayNotes = await this.fetchNotesFromApi(lastSyncTime);

            // 3. 处理 API 响应
            const processingResults = await this.processApiResponse(dayNotes);
            processedCount = processingResults.processed;
            deletedCount = processingResults.deleted;

            // 4. 更新同步时间
            const newLastSyncTime = formatDate(syncStartTime);
            console.log("保存新的同步时间：", newLastSyncTime);
            await this.saveData("sync_data.json", {
                ...pData,
                lastSyncTime: newLastSyncTime,
            });

            console.log("Dinox: 同步成功完成");
            showMessage(`同步完成！处理：${processedCount}, 删除：${deletedCount}`, 5000, "info");
            
            // 同步完成后刷新状态显示
            this.refreshSyncStatus();
        } catch (error) {
            errorOccurred = true;
            console.error("Dinox: 同步失败：", error);
            showMessage(`同步失败：${error.message}`, 10000, "error");
        } finally {
            this.isSyncing = false;
        }
    }

    private async fetchNotesFromApi(lastSyncTime: string): Promise<DayNote[]> {
        const requestBody = {
            noteId: 0,
            lastSyncTime: lastSyncTime,
        };

        console.log("调用 API，请求体：", requestBody);

        try {
            const resp = await axios.post(`${API_BASE_URL_AI}/api/openapi/listNotes`, requestBody, {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": this.settings.token
                }
            });

            if (resp.status !== 200) {
                throw new Error(`API HTTP 错误：状态 ${resp.status}`);
            }

            const result = resp.data as GetNoteApiResult;

            if (!result || result.code !== "000000") {
                const errorMsg = result?.msg || "未知 API 错误";
                throw new Error(`API 逻辑错误：代码 ${result?.code || "N/A"} - ${errorMsg}`);
            }

            console.log(`接收到 ${result.data?.length || 0} 天的笔记数据`);
            return result.data || [];
        } catch (error) {
            console.error("从 API 获取数据时出错：", error);
            throw error;
        }
    }

    private async processApiResponse(dayNotes: DayNote[]): Promise<{ processed: number; deleted: number }> {
        let processed = 0;
        let deleted = 0;
        console.log("处理 API 响应：", dayNotes);

        for (const dayData of dayNotes) {
            for (const noteData of dayData.notes) {
                try {
                    const result = await this.handleNoteProcessing(noteData, dayData.date);
                    if (result === "deleted") deleted++;
                    else if (result === "processed") processed++;
                } catch (noteError) {
                    console.error(`处理笔记 ${noteData.noteId} 失败：`, noteError);
                    showMessage(`处理笔记失败 ${noteData.noteId.substring(0, 8)}...`, 5000, "error");
                }
            }
        }
        return { processed, deleted };
    }

    private async handleNoteProcessing(noteData: Note, date: string): Promise<"processed" | "deleted" | "skipped"> {
        const sourceId = noteData.noteId;

        // 生成文件名
        let filename = "";
        const format = this.settings.filenameFormat;

        if (format === "noteId") {
            filename = sourceId;
        } else if (format === "title") {
            if (noteData.title && noteData.title.trim() !== "") {
                filename = sanitizeFilename(noteData.title);
            } else {
                filename = sourceId;
            }
        } else if (format === "time") {
            try {
                const createDate = new Date(noteData.createTime);
                filename = sanitizeFilename(formatDate(createDate));
            } catch (e) {
                console.warn(`无效的创建时间，使用 noteId 作为文件名`, noteData.createTime);
                filename = sourceId;
            }
        } else {
            filename = sourceId;
        }

        filename = filename || sourceId || "Untitled";

        // 确定路径
        let notePath = "";
        if (this.settings.fileLayout === "nested") {
            const safeDate = date.replace(/[^0-9-]/g, "");
            notePath = `/${safeDate}/${filename}`;
        } else {
            notePath = `/${filename}`;
        }

        // 处理删除或创建/更新
        if (noteData.isDel) {
            const ids = await getIDsByHPath(this.settings.notebookId, notePath);
            if (ids.length > 0) {
                console.log(`删除标记为删除的笔记：${notePath}`);
                try {
                    const id = ids[0];
                    const path = await getPathByID(id);
                    await removeDoc(this.settings.notebookId, path);
                    return "deleted";
                } catch (deleteError) {
                    console.error(`删除文件失败 ${notePath}：`, deleteError);
                    throw deleteError;
                }
            } else {
                return "skipped";
            }
        } else {
            try {
                // 检查是否已存在，如果存在则删除后重建
                const ids = await getIDsByHPath(this.settings.notebookId, notePath);
                if (ids.length > 0) {
                    const id = ids[0];
                    const path = await getPathByID(id);
                    await removeDoc(this.settings.notebookId, path);
                }

                console.log(`创建/更新笔记：${notePath}`);
                
                // 直接使用笔记内容，不进行模板渲染
                const content = noteData.content || "";
                
                // 创建文档（只包含正文内容）
                const docId = await createDocWithMd(this.settings.notebookId, notePath, content);
                
                // 设置 block attributes 存储元数据
                const attrs: { [key: string]: string } = {
                    "dinoxNoteId": noteData.noteId,
                    "dinoxTitle": noteData.title || "",
                    "dinoxCreateTime": noteData.createTime || "",
                    "dinoxIsAudio": noteData.isAudio ? "true" : "false",
                    "dinoxType": noteData.type,
                    "dinoxZettelBoxes": noteData.zettelBoxes?.join(",") || "",
                    "dinoxTags": noteData.tags?.join(",") || "",
                };

                // 设置属性到文档根块
                await setBlockAttrs(docId, attrs);

                console.log(`成功创建笔记并设置属性：${notePath}`);
                return "processed";
            } catch (error) {
                console.error(`创建/更新文件失败 ${notePath}：`, error);
                throw error;
            }
        }
    }



    private addMenu(rect?: DOMRect) {
        const menu = new Menu("topBarDinoxSync", () => {
            console.log("Dinox 同步菜单关闭");
        });
        
        menu.addItem({
            icon: "iconRefresh",
            label: "同步笔记",
            accelerator: this.commands[0]?.customHotkey,
            click: () => {
                this.fetchData();
            }
        });

        menu.addItem({
            icon: "iconTrashcan",
            label: "重置同步状态",
            click: async () => {
                confirm("⚠️", "确定要重置同步状态吗？下次同步将获取所有笔记。", async () => {
                    await this.saveData("sync_data.json", {
                        lastSyncTime: "1900-01-01 00:00:00"
                    });
                    showMessage("同步状态已重置！", 3000, "info");
                });
            }
        });

        menu.addItem({
            icon: "iconSettings",
            label: "打开设置",
            click: () => {
                // 调用思源的设置面板（如果有的话）
                showMessage("请在插件管理中打开设置面板", 3000, "info");
            }
        });

        if (this.isMobile) {
            menu.fullscreen();
        } else {
            menu.open({
                x: rect.right,
                y: rect.bottom,
                isLeft: true,
            });
        }
    }


}
