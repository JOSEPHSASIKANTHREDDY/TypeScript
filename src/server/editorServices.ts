/// <reference path="..\compiler\commandLineParser.ts" />
/// <reference path="..\services\services.ts" />
/// <reference path="utilities.ts" />
/// <reference path="session.ts" />
/// <reference path="scriptVersionCache.ts"/>
/// <reference path="lsHost.ts"/>
/// <reference path="project.ts"/>
/// <reference path="typingsCache.ts"/>

namespace ts.server {
    export const maxProgramSizeForNonTsFiles = 20 * 1024 * 1024;

    export const ContextEvent = "context";
    export const ConfigFileDiagEvent = "configFileDiag";
    export const ProjectLanguageServiceStateEvent = "projectLanguageServiceState";
    export const ProjectInfoTelemetryEvent = "projectInfo";

    export interface ContextEvent {
        eventName: typeof ContextEvent;
        data: { project: Project; fileName: NormalizedPath };
    }

    export interface ConfigFileDiagEvent {
        eventName: typeof ConfigFileDiagEvent;
        data: { triggerFile: string, configFileName: string, diagnostics: Diagnostic[] };
    }

    export interface ProjectLanguageServiceStateEvent {
        eventName: typeof ProjectLanguageServiceStateEvent;
        data: { project: Project, languageServiceEnabled: boolean };
    }

    /** This will be converted to the payload of a protocol.TelemetryEvent in session.defaultEventHandler. */
    export interface ProjectInfoTelemetryEvent {
        readonly eventName: typeof ProjectInfoTelemetryEvent;
        readonly data: ProjectInfoTelemetryEventData;
    }

    export interface ProjectInfoTelemetryEventData {
        /** Cryptographically secure hash of project file location. */
        readonly projectId: string;
        /** Count of file extensions seen in the project. */
        readonly fileStats: FileStats;
        /**
         * Any compiler options that might contain paths will be taken out.
         * Enum compiler options will be converted to strings.
         */
        readonly compilerOptions: CompilerOptions;
        // "extends", "files", "include", or "exclude" will be undefined if an external config is used.
        // Otherwise, we will use "true" if the property is present and "false" if it is missing.
        readonly extends: boolean | undefined;
        readonly files: boolean | undefined;
        readonly include: boolean | undefined;
        readonly exclude: boolean | undefined;
        readonly compileOnSave: boolean;
        readonly typeAcquisition: ProjectInfoTypeAcquisitionData;

        readonly configFileName: "tsconfig.json" | "jsconfig.json" | "other";
        readonly projectType: "external" | "configured";
        readonly languageServiceEnabled: boolean;
        /** TypeScript version used by the server. */
        readonly version: string;
    }

    export interface ProjectInfoTypeAcquisitionData {
        readonly enable: boolean;
        // Actual values of include/exclude entries are scrubbed.
        readonly include: boolean;
        readonly exclude: boolean;
    }

    export interface FileStats {
        readonly js: number;
        readonly jsx: number;
        readonly ts: number;
        readonly tsx: number;
        readonly dts: number;
    }

    export type ProjectServiceEvent = ContextEvent | ConfigFileDiagEvent | ProjectLanguageServiceStateEvent | ProjectInfoTelemetryEvent;

    export interface ProjectServiceEventHandler {
        (event: ProjectServiceEvent): void;
    }

    export interface SafeList {
        [name: string]: { match: RegExp, exclude?: Array<Array<string | number>>, types?: string[] };
    }

    function prepareConvertersForEnumLikeCompilerOptions(commandLineOptions: CommandLineOption[]): Map<Map<number>> {
        const map: Map<Map<number>> = createMap<Map<number>>();
        for (const option of commandLineOptions) {
            if (typeof option.type === "object") {
                const optionMap = <Map<number>>option.type;
                // verify that map contains only numbers
                optionMap.forEach(value => {
                    Debug.assert(typeof value === "number");
                });
                map.set(option.name, optionMap);
            }
        }
        return map;
    }

    const compilerOptionConverters = prepareConvertersForEnumLikeCompilerOptions(optionDeclarations);
    const indentStyle = createMapFromTemplate({
        "none": IndentStyle.None,
        "block": IndentStyle.Block,
        "smart": IndentStyle.Smart
    });

    /**
     * How to understand this block:
     *  * The 'match' property is a regexp that matches a filename.
     *  * If 'match' is successful, then:
     *     * All files from 'exclude' are removed from the project. See below.
     *     * All 'types' are included in ATA
     *  * What the heck is 'exclude' ?
     *     * An array of an array of strings and numbers
     *     * Each array is:
     *       * An array of strings and numbers
     *       * The strings are literals
     *       * The numbers refer to capture group indices from the 'match' regexp
     *          * Remember that '1' is the first group
     *       * These are concatenated together to form a new regexp
     *       * Filenames matching these regexps are excluded from the project
     * This default value is tested in tsserverProjectSystem.ts; add tests there
     *   if you are changing this so that you can be sure your regexp works!
     */
    const defaultTypeSafeList: SafeList = {
        "jquery": {
            // jquery files can have names like "jquery-1.10.2.min.js" (or "jquery.intellisense.js")
            "match": /jquery(-(\.?\d+)+)?(\.intellisense)?(\.min)?\.js$/i,
            "types": ["jquery"]
        },
        "WinJS": {
            // e.g. c:/temp/UWApp1/lib/winjs-4.0.1/js/base.js
            "match": /^(.*\/winjs-[.\d]+)\/js\/base\.js$/i,        // If the winjs/base.js file is found..
            "exclude": [["^", 1, "/.*"]],                // ..then exclude all files under the winjs folder
            "types": ["winjs"]                           // And fetch the @types package for WinJS
        },
        "Kendo": {
            // e.g. /Kendo3/wwwroot/lib/kendo/kendo.all.min.js
            "match": /^(.*\/kendo)\/kendo\.all\.min\.js$/i,
            "exclude": [["^", 1, "/.*"]],
            "types": ["kendo-ui"]
        },
        "Office Nuget": {
            // e.g. /scripts/Office/1/excel-15.debug.js
            "match": /^(.*\/office\/1)\/excel-\d+\.debug\.js$/i, // Office NuGet package is installed under a "1/office" folder
            "exclude": [["^", 1, "/.*"]],                     // Exclude that whole folder if the file indicated above is found in it
            "types": ["office"]                               // @types package to fetch instead
        },
        "Minified files": {
            // e.g. /whatever/blah.min.js
            "match": /^(.+\.min\.js)$/i,
            "exclude": [["^", 1, "$"]]
        }
    };

    export function convertFormatOptions(protocolOptions: protocol.FormatCodeSettings): FormatCodeSettings {
        if (typeof protocolOptions.indentStyle === "string") {
            protocolOptions.indentStyle = indentStyle.get(protocolOptions.indentStyle.toLowerCase());
            Debug.assert(protocolOptions.indentStyle !== undefined);
        }
        return <any>protocolOptions;
    }

    export function convertCompilerOptions(protocolOptions: protocol.ExternalProjectCompilerOptions): CompilerOptions & protocol.CompileOnSaveMixin {
        compilerOptionConverters.forEach((mappedValues, id) => {
            const propertyValue = protocolOptions[id];
            if (typeof propertyValue === "string") {
                protocolOptions[id] = mappedValues.get(propertyValue.toLowerCase());
            }
        });
        return <any>protocolOptions;
    }

    export function tryConvertScriptKindName(scriptKindName: protocol.ScriptKindName | ScriptKind): ScriptKind {
        return typeof scriptKindName === "string"
            ? convertScriptKindName(scriptKindName)
            : scriptKindName;
    }

    export function convertScriptKindName(scriptKindName: protocol.ScriptKindName) {
        switch (scriptKindName) {
            case "JS":
                return ScriptKind.JS;
            case "JSX":
                return ScriptKind.JSX;
            case "TS":
                return ScriptKind.TS;
            case "TSX":
                return ScriptKind.TSX;
            default:
                return ScriptKind.Unknown;
        }
    }

    /**
     * This helper function processes a list of projects and return the concatenated, sortd and deduplicated output of processing each project.
     */
    export function combineProjectOutput<T>(projects: Project[], action: (project: Project) => T[], comparer?: (a: T, b: T) => number, areEqual?: (a: T, b: T) => boolean) {
        const result = flatMap(projects, action).sort(comparer);
        return projects.length > 1 ? deduplicate(result, areEqual) : result;
    }

    export interface HostConfiguration {
        formatCodeOptions: FormatCodeSettings;
        hostInfo: string;
        extraFileExtensions?: JsFileExtensionInfo[];
    }

    export interface OpenConfiguredProjectResult {
        configFileName?: NormalizedPath;
        configFileErrors?: Diagnostic[];
    }

    interface FilePropertyReader<T> {
        getFileName(f: T): string;
        getScriptKind(f: T): ScriptKind;
        hasMixedContent(f: T, extraFileExtensions: JsFileExtensionInfo[]): boolean;
    }

    const fileNamePropertyReader: FilePropertyReader<string> = {
        getFileName: x => x,
        getScriptKind: _ => undefined,
        hasMixedContent: (fileName, extraFileExtensions) => some(extraFileExtensions, ext => ext.isMixedContent && fileExtensionIs(fileName, ext.extension)),
    };

    const externalFilePropertyReader: FilePropertyReader<protocol.ExternalFile> = {
        getFileName: x => x.fileName,
        getScriptKind: x => tryConvertScriptKindName(x.scriptKind),
        hasMixedContent: x => x.hasMixedContent
    };

    function findProjectByName<T extends Project>(projectName: string, projects: T[]): T {
        for (const proj of projects) {
            if (proj.getProjectName() === projectName) {
                return proj;
            }
        }
    }

    /* @internal */
    export const enum WatchType {
        ConfigFilePath = "Config file for the program",
        MissingFilePath = "Missing file from program",
        WildCardDirectories = "Wild card directory",
        TypeRoot = "Type root of the project",
        ClosedScriptInfo = "Closed Script info",
        ConfigFileForInferredRoot = "Config file for the inferred project root"
    }

    /* @internal */
    export const enum WatcherCloseReason {
        ProjectClose = "Project close",
        NotNeeded = "After project update isnt required any more",
        FileCreated = "File got created",
        RecursiveChanged = "Recursive changed for the watch",
        ProjectReloadHitMaxSize = "Project reloaded and hit the max file size capacity",
        OrphanScriptInfoWithChange = "Orphan script info, Detected change in file thats not needed any more",
        OrphanScriptInfo = "Removing Orphan script info as part of cleanup",
        FileDeleted = "File was deleted",
        FileOpened = "File opened",
        ConfigProjectCreated = "Config file project created",
        FileClosed = "File is closed"
    }

    const enum ConfigFileWatcherStatus {
        ReloadingFiles = "Reloading configured projects for files",
        ReloadingInferredRootFiles = "Reloading configured projects for only inferred root files",
        UpdatedCallback = "Updated the callback",
        TrackingFileAdded = "Tracking file added",
        TrackingFileRemoved = "Tracking file removed",
        InferredRootAdded = "Inferred Root file added",
        InferredRootRemoved = "Inferred Root file removed",
    }

    /* @internal */
    export type ServerDirectoryWatcherCallback = (path: NormalizedPath) => void;

    type ConfigFileExistence = {
        /**
         * Cached value of existence of config file
         */
        exists: boolean;
        /**
         * The value in the open files map is true if the file is inferred project root
         * Otherwise its false
         */
        trackingOpenFilesMap: Map<boolean>;
        /**
         * The file watcher corresponding to this config file for the inferred project root
         * The watcher is present only when there is no open configured project for this config file
         */
        configFileWatcher?: FileWatcher;
    };

    export interface ProjectServiceOptions {
        host: ServerHost;
        logger: Logger;
        cancellationToken: HostCancellationToken;
        useSingleInferredProject: boolean;
        typingsInstaller: ITypingsInstaller;
        eventHandler?: ProjectServiceEventHandler;
        throttleWaitMilliseconds?: number;
        globalPlugins?: string[];
        pluginProbeLocations?: string[];
        allowLocalPluginLoads?: boolean;
    }

    export class ProjectService {

        public readonly typingsCache: TypingsCache;

        private readonly documentRegistry: DocumentRegistry;

        /**
         * Container of all known scripts
         */
        private readonly filenameToScriptInfo = createMap<ScriptInfo>();
        /**
         * maps external project file name to list of config files that were the part of this project
         */
        private readonly externalProjectToConfiguredProjectMap: Map<NormalizedPath[]> = createMap<NormalizedPath[]>();

        /**
         * external projects (configuration and list of root files is not controlled by tsserver)
         */
        readonly externalProjects: ExternalProject[] = [];
        /**
         * projects built from openFileRoots
         */
        readonly inferredProjects: InferredProject[] = [];
        /**
         * projects specified by a tsconfig.json file
         */
        readonly configuredProjects = createMap<ConfiguredProject>();
        /**
         * list of open files
         */
        readonly openFiles: ScriptInfo[] = [];

        private compilerOptionsForInferredProjects: CompilerOptions;
        private compileOnSaveForInferredProjects: boolean;
        private readonly projectToSizeMap: Map<number> = createMap<number>();
        private readonly mapOfConfigFilePresence: Map<ConfigFileExistence>;
        private readonly throttledOperations: ThrottledOperations;

        private readonly hostConfiguration: HostConfiguration;
        private safelist: SafeList = defaultTypeSafeList;

        private changedFiles: ScriptInfo[];
        private pendingProjectUpdates = createMap<Project>();
        private pendingInferredProjectUpdate: boolean;

        readonly currentDirectory: string;
        readonly toCanonicalFileName: (f: string) => string;

        public readonly host: ServerHost;
        public readonly logger: Logger;
        public readonly cancellationToken: HostCancellationToken;
        public readonly useSingleInferredProject: boolean;
        public readonly typingsInstaller: ITypingsInstaller;
        public readonly throttleWaitMilliseconds?: number;
        private readonly eventHandler?: ProjectServiceEventHandler;

        public readonly globalPlugins: ReadonlyArray<string>;
        public readonly pluginProbeLocations: ReadonlyArray<string>;
        public readonly allowLocalPluginLoads: boolean;

        /** Tracks projects that we have already sent telemetry for. */
        private readonly seenProjects = createMap<true>();

        constructor(opts: ProjectServiceOptions) {
            this.host = opts.host;
            this.logger = opts.logger;
            this.cancellationToken = opts.cancellationToken;
            this.useSingleInferredProject = opts.useSingleInferredProject;
            this.typingsInstaller = opts.typingsInstaller || nullTypingsInstaller;
            this.throttleWaitMilliseconds = opts.throttleWaitMilliseconds;
            this.eventHandler = opts.eventHandler;
            this.globalPlugins = opts.globalPlugins || emptyArray;
            this.pluginProbeLocations = opts.pluginProbeLocations || emptyArray;
            this.allowLocalPluginLoads = !!opts.allowLocalPluginLoads;

            Debug.assert(!!this.host.createHash, "'ServerHost.createHash' is required for ProjectService");

            this.currentDirectory = this.host.getCurrentDirectory();
            this.toCanonicalFileName = createGetCanonicalFileName(this.host.useCaseSensitiveFileNames);
            this.mapOfConfigFilePresence = createMap<ConfigFileExistence>();
            this.throttledOperations = new ThrottledOperations(this.host);

            this.typingsInstaller.attach(this);

            this.typingsCache = new TypingsCache(this.typingsInstaller);

            this.hostConfiguration = {
                formatCodeOptions: getDefaultFormatCodeSettings(this.host),
                hostInfo: "Unknown host",
                extraFileExtensions: []
            };

            this.documentRegistry = createDocumentRegistry(this.host.useCaseSensitiveFileNames, this.currentDirectory);
        }

        toPath(fileName: string, basePath = this.currentDirectory) {
            return toPath(fileName, basePath, this.toCanonicalFileName);
        }

        /* @internal */
        getChangedFiles_TestOnly() {
            return this.changedFiles;
        }

        ensureInferredProjectsUpToDate_TestOnly() {
            this.ensureInferredProjectsUpToDate();
        }

        getCompilerOptionsForInferredProjects() {
            return this.compilerOptionsForInferredProjects;
        }

        onUpdateLanguageServiceStateForProject(project: Project, languageServiceEnabled: boolean) {
            if (!this.eventHandler) {
                return;
            }
            this.eventHandler(<ProjectLanguageServiceStateEvent>{
                eventName: ProjectLanguageServiceStateEvent,
                data: { project, languageServiceEnabled }
            });
        }

        updateTypingsForProject(response: SetTypings | InvalidateCachedTypings): void {
            const project = this.findProject(response.projectName);
            if (!project) {
                return;
            }
            switch (response.kind) {
                case ActionSet:
                    this.typingsCache.updateTypingsForProject(response.projectName, response.compilerOptions, response.typeAcquisition, response.unresolvedImports, response.typings);
                    break;
                case ActionInvalidate:
                    this.typingsCache.deleteTypingsForProject(response.projectName);
                    break;
            }
            project.markAsDirty();
            this.delayUpdateProjectGraphAndInferredProjectsRefresh(project);
        }

        private delayInferredProjectsRefresh() {
            this.pendingInferredProjectUpdate = true;
            this.throttledOperations.schedule("*refreshInferredProjects*", /*delay*/ 250, () => {
                if (this.pendingProjectUpdates.size !== 0) {
                    this.delayInferredProjectsRefresh();
                }
                else if (this.pendingInferredProjectUpdate) {
                    this.pendingInferredProjectUpdate = false;
                    this.refreshInferredProjects();
                }
            });
        }

        private delayUpdateProjectGraph(project: Project) {
            const projectName = project.getProjectName();
            this.pendingProjectUpdates.set(projectName, project);
            this.throttledOperations.schedule(projectName, /*delay*/ 250, () => {
                const project = this.pendingProjectUpdates.get(projectName);
                if (project) {
                    this.pendingProjectUpdates.delete(projectName);
                    project.updateGraph();
                }
            });
        }

        delayUpdateProjectGraphAndInferredProjectsRefresh(project: Project) {
            this.delayUpdateProjectGraph(project);
            this.delayInferredProjectsRefresh();
        }

        private delayUpdateProjectGraphs(projects: Project[]) {
            for (const project of projects) {
                this.delayUpdateProjectGraph(project);
            }
            this.delayInferredProjectsRefresh();
        }

        setCompilerOptionsForInferredProjects(projectCompilerOptions: protocol.ExternalProjectCompilerOptions): void {
            this.compilerOptionsForInferredProjects = convertCompilerOptions(projectCompilerOptions);
            // always set 'allowNonTsExtensions' for inferred projects since user cannot configure it from the outside
            // previously we did not expose a way for user to change these settings and this option was enabled by default
            this.compilerOptionsForInferredProjects.allowNonTsExtensions = true;
            this.compileOnSaveForInferredProjects = projectCompilerOptions.compileOnSave;
            for (const proj of this.inferredProjects) {
                proj.setCompilerOptions(this.compilerOptionsForInferredProjects);
                proj.compileOnSaveEnabled = projectCompilerOptions.compileOnSave;
                proj.markAsDirty();
            }
            this.delayUpdateProjectGraphs(this.inferredProjects);
        }

        findProject(projectName: string): Project {
            if (projectName === undefined) {
                return undefined;
            }
            if (isInferredProjectName(projectName)) {
                this.ensureInferredProjectsUpToDate();
                return findProjectByName(projectName, this.inferredProjects);
            }
            return this.findExternalProjectByProjectName(projectName) || this.findConfiguredProjectByProjectName(toNormalizedPath(projectName));
        }

        getDefaultProjectForFile(fileName: NormalizedPath, refreshInferredProjects: boolean) {
            if (refreshInferredProjects) {
                this.ensureInferredProjectsUpToDate();
            }
            const scriptInfo = this.getScriptInfoForNormalizedPath(fileName);
            return scriptInfo && scriptInfo.getDefaultProject();
        }

        /**
         * Ensures the project structures are upto date
         * @param refreshInferredProjects when true updates the inferred projects even if there is no pending work
         */
        private ensureInferredProjectsUpToDate(refreshInferredProjects?: boolean) {
            if (this.changedFiles) {
                let projectsToUpdate: Project[];
                if (this.changedFiles.length === 1) {
                    // simpliest case - no allocations
                    projectsToUpdate = this.changedFiles[0].containingProjects;
                }
                else {
                    projectsToUpdate = [];
                    for (const f of this.changedFiles) {
                        projectsToUpdate = projectsToUpdate.concat(f.containingProjects);
                    }
                }
                this.changedFiles = undefined;
                this.updateProjectGraphs(projectsToUpdate);
            }

            if (this.pendingProjectUpdates.size !== 0) {
                const projectsToUpdate = arrayFrom(this.pendingProjectUpdates.values());
                this.pendingProjectUpdates.clear();
                this.updateProjectGraphs(projectsToUpdate);
            }

            if (this.pendingInferredProjectUpdate || refreshInferredProjects) {
                this.pendingInferredProjectUpdate = false;
                this.refreshInferredProjects();
            }
        }

        private findContainingExternalProject(fileName: NormalizedPath): ExternalProject {
            for (const proj of this.externalProjects) {
                if (proj.containsFile(fileName)) {
                    return proj;
                }
            }
            return undefined;
        }

        getFormatCodeOptions(file?: NormalizedPath) {
            let formatCodeSettings: FormatCodeSettings;
            if (file) {
                const info = this.getScriptInfoForNormalizedPath(file);
                if (info) {
                    formatCodeSettings = info.getFormatCodeSettings();
                }
            }
            return formatCodeSettings || this.hostConfiguration.formatCodeOptions;
        }

        private updateProjectGraphs(projects: Project[]) {
            for (const p of projects) {
                if (!p.updateGraph()) {
                    this.pendingInferredProjectUpdate = true;
                }
            }
        }

        private onSourceFileChanged(fileName: NormalizedPath, eventKind: FileWatcherEventKind) {
            const info = this.getScriptInfoForNormalizedPath(fileName);
            if (!info) {
                this.logger.info(`Error: got watch notification for unknown file: ${fileName}`);
                return;
            }

            if (eventKind === FileWatcherEventKind.Deleted) {
                // File was deleted
                this.handleDeletedFile(info);
            }
            else {
                if (!info.isScriptOpen()) {
                    if (info.containingProjects.length === 0) {
                        // Orphan script info, remove it as we can always reload it on next open file request
                        this.stopWatchingScriptInfo(info, WatcherCloseReason.OrphanScriptInfoWithChange);
                        this.filenameToScriptInfo.delete(info.path);
                    }
                    else {
                        // file has been changed which might affect the set of referenced files in projects that include
                        // this file and set of inferred projects
                        info.reloadFromFile();
                        this.delayUpdateProjectGraphs(info.containingProjects);
                    }
                }
            }
        }

        private handleDeletedFile(info: ScriptInfo) {
            this.stopWatchingScriptInfo(info, WatcherCloseReason.FileDeleted);

            // TODO: handle isOpen = true case

            if (!info.isScriptOpen()) {
                this.filenameToScriptInfo.delete(info.path);

                // capture list of projects since detachAllProjects will wipe out original list
                const containingProjects = info.containingProjects.slice();

                info.detachAllProjects();

                // update projects to make sure that set of referenced files is correct
                this.delayUpdateProjectGraphs(containingProjects);

                // TODO: (sheetalkamat) Someway to send this event so that error checks are updated?
                // if (!this.eventHandler) {
                //     return;
                // }

                // for (const openFile of this.openFiles) {
                //     this.eventHandler(<ContextEvent>{
                //         eventName: ContextEvent,
                //         data: { project: openFile.getDefaultProject(), fileName: openFile.fileName }
                //     });
                // }
            }
        }

        /* @internal  */
        onTypeRootFileChanged(project: ConfiguredProject, fileName: NormalizedPath) {
            project.getCachedServerHost().addOrDeleteFileOrFolder(fileName);
            project.updateTypes();
            this.delayUpdateProjectGraphAndInferredProjectsRefresh(project);
        }

        /**
         * This is the callback function when a watched directory has added or removed source code files.
         * @param project the project that associates with this directory watcher
         * @param fileName the absolute file name that changed in watched directory
         */
        /* @internal */
        onFileAddOrRemoveInWatchedDirectoryOfProject(project: ConfiguredProject, fileName: NormalizedPath) {
            project.getCachedServerHost().addOrDeleteFileOrFolder(fileName);
            const configFilename = project.getConfigFilePath();

            // If a change was made inside "folder/file", node will trigger the callback twice:
            // one with the fileName being "folder/file", and the other one with "folder".
            // We don't respond to the second one.
            if (fileName && !isSupportedSourceFileName(fileName, project.getCompilerOptions(), this.hostConfiguration.extraFileExtensions)) {
                this.logger.info(`Project: ${configFilename} Detected file add/remove of non supported extension: ${fileName}`);
                return;
            }

            const configFileSpecs = project.configFileSpecs;
            const result = getFileNamesFromConfigSpecs(configFileSpecs, getDirectoryPath(configFilename), project.getCompilerOptions(), project.getCachedServerHost(), this.hostConfiguration.extraFileExtensions);
            const errors = project.getAllProjectErrors();
            const isErrorNoInputFiles = (error: Diagnostic) => error.code === Diagnostics.No_inputs_were_found_in_config_file_0_Specified_include_paths_were_1_and_exclude_paths_were_2.code;
            if (result.fileNames.length !== 0) {
                filterMutate(errors, error => !isErrorNoInputFiles(error));
            }
            else if (!configFileSpecs.filesSpecs && !some(errors, isErrorNoInputFiles)) {
                errors.push(getErrorForNoInputFiles(configFileSpecs, configFilename));
            }
            this.updateNonInferredProjectFiles(project, result.fileNames, fileNamePropertyReader, /*clientFileName*/ undefined);
            this.delayUpdateProjectGraphAndInferredProjectsRefresh(project);
        }

        private onConfigChangedForConfiguredProject(project: ConfiguredProject, eventKind: FileWatcherEventKind) {
            const configFilePresenceInfo = this.mapOfConfigFilePresence.get(project.canonicalConfigFilePath);
            if (eventKind === FileWatcherEventKind.Deleted) {
                // Update the cached status
                // No action needed on tracking open files since the existing config file anyways didnt affect the tracking file
                configFilePresenceInfo.exists = false;
                this.removeProject(project);

                // Reload the configured projects for the open files in the map as they are affectected by this config file
                this.logConfigFileWatchUpdate(project.getConfigFilePath(), configFilePresenceInfo, ConfigFileWatcherStatus.ReloadingFiles);
                // Since the configured project was deleted, we want to reload projects for all the open files
                this.delayReloadConfiguredProjectForFiles(configFilePresenceInfo.trackingOpenFilesMap, /*ignoreIfNotInferredProjectRoot*/ false);
            }
            else {
                this.logConfigFileWatchUpdate(project.getConfigFilePath(), configFilePresenceInfo, ConfigFileWatcherStatus.ReloadingInferredRootFiles);
                project.pendingReload = true;
                this.delayUpdateProjectGraph(project);
                // As we scheduled the updated project graph, we would need to only schedule the project reload for the inferred project roots
                this.delayReloadConfiguredProjectForFiles(configFilePresenceInfo.trackingOpenFilesMap, /*ignoreIfNotInferredProjectRoot*/ true);
            }
        }

        /**
         * This is the callback function for the config file add/remove/change at any location that matters to open
         * script info but doesnt have configured project open for the config file
         */
        private onConfigFileChangeForOpenScriptInfo(configFileName: NormalizedPath, eventKind: FileWatcherEventKind) {
            // This callback is called only if we dont have config file project for this config file
            const cononicalConfigPath = normalizedPathToPath(configFileName, this.currentDirectory, this.toCanonicalFileName);
            const configFilePresenceInfo = this.mapOfConfigFilePresence.get(cononicalConfigPath);
            configFilePresenceInfo.exists = (eventKind !== FileWatcherEventKind.Deleted);
            this.logConfigFileWatchUpdate(configFileName, configFilePresenceInfo, ConfigFileWatcherStatus.ReloadingFiles);
            // The tracking opens files would only contaion the inferred root so no need to check
            this.delayReloadConfiguredProjectForFiles(configFilePresenceInfo.trackingOpenFilesMap, /*ignoreIfNotInferredProjectRoot*/ false);
        }

        private removeProject(project: Project) {
            this.logger.info(`remove project: ${project.getRootFiles().toString()}`);

            project.close();
            // Remove the project from pending project updates
            this.pendingProjectUpdates.delete(project.getProjectName());

            switch (project.projectKind) {
                case ProjectKind.External:
                    unorderedRemoveItem(this.externalProjects, <ExternalProject>project);
                    this.projectToSizeMap.delete((project as ExternalProject).externalProjectName);
                    break;
                case ProjectKind.Configured:
                    this.configuredProjects.delete((<ConfiguredProject>project).canonicalConfigFilePath);
                    this.projectToSizeMap.delete((project as ConfiguredProject).canonicalConfigFilePath);
                    this.setConfigFilePresenceByClosedConfigFile(<ConfiguredProject>project);
                    break;
                case ProjectKind.Inferred:
                    unorderedRemoveItem(this.inferredProjects, <InferredProject>project);
                    break;
            }
        }

        private assignScriptInfoToInferredProjectIfNecessary(info: ScriptInfo, addToListOfOpenFiles: boolean): void {
            if (info.containingProjects.length === 0) {
                // create new inferred project p with the newly opened file as root
                // or add root to existing inferred project if 'useOneInferredProject' is true
                this.createInferredProjectWithRootFileIfNecessary(info);

                // if useOneInferredProject is not set then try to fixup ownership of open files
                // check 'defaultProject !== inferredProject' is necessary to handle cases
                // when creation inferred project for some file has added other open files into this project
                // (i.e.as referenced files)
                // we definitely don't want to delete the project that was just created
                // Also note that we need to create a copy of the array since the list of project will change
                for (const inferredProject of this.inferredProjects.slice(0, this.inferredProjects.length - 1)) {
                    Debug.assert(!this.useSingleInferredProject);
                    // Remove this file from the root of inferred project if its part of more than 2 projects
                    // This logic is same as iterating over all open files and calling
                    // this.removRootOfInferredProjectIfNowPartOfOtherProject(f);
                    // Since this is also called from refreshInferredProject and closeOpen file
                    // to update inferred projects of the open file, this iteration might be faster
                    // instead of scanning all open files
                    const root = inferredProject.getRootScriptInfos();
                    Debug.assert(root.length === 1);
                    if (root[0].containingProjects.length > 1) {
                        this.removeProject(inferredProject);
                    }
                }
            }
            else {
                for (const p of info.containingProjects) {
                    // file is the part of configured project
                    if (p.projectKind === ProjectKind.Configured) {
                        if (addToListOfOpenFiles) {
                            ((<ConfiguredProject>p)).addOpenRef();
                        }
                    }
                }
            }

            if (addToListOfOpenFiles) {
                this.openFiles.push(info);
            }
        }

        /**
         * Remove this file from the set of open, non-configured files.
         * @param info The file that has been closed or newly configured
         */
        private closeOpenFile(info: ScriptInfo): void {
            // Closing file should trigger re-reading the file content from disk. This is
            // because the user may chose to discard the buffer content before saving
            // to the disk, and the server's version of the file can be out of sync.
            info.close();
            this.stopWatchingConfigFilesForClosedScriptInfo(info);

            unorderedRemoveItem(this.openFiles, info);

            // collect all projects that should be removed
            let projectsToRemove: Project[];
            for (const p of info.containingProjects) {
                if (p.projectKind === ProjectKind.Configured) {
                    if (info.hasMixedContent) {
                        info.registerFileUpdate();
                    }
                    // last open file in configured project - close it
                    if ((<ConfiguredProject>p).deleteOpenRef() === 0) {
                        (projectsToRemove || (projectsToRemove = [])).push(p);
                    }
                }
                else if (p.projectKind === ProjectKind.Inferred && p.isRoot(info)) {
                    // If this was the open root file of inferred project
                    if ((p as InferredProject).isProjectWithSingleRoot()) {
                        // - when useSingleInferredProject is not set, we can guarantee that this will be the only root
                        // - other wise remove the project if it is the only root
                        (projectsToRemove || (projectsToRemove = [])).push(p);
                    }
                    else {
                        p.removeFile(info);
                    }
                }

                if (!p.languageServiceEnabled) {
                    // if project language service is disabled then we create a program only for open files.
                    // this means that project should be marked as dirty to force rebuilding of the program
                    // on the next request
                    p.markAsDirty();
                }
            }
            if (projectsToRemove) {
                for (const project of projectsToRemove) {
                    this.removeProject(project);
                }

                // collect orphanted files and try to re-add them as newly opened
                // treat orphaned files as newly opened
                // for all open files
                for (const f of this.openFiles) {
                    if (f.containingProjects.length === 0) {
                        this.assignScriptInfoToInferredProjectIfNecessary(f, /*addToListOfOpenFiles*/ false);
                    }
                }

                // Cleanup script infos that arent part of any project is postponed to
                // next file open so that if file from same project is opened we wont end up creating same script infos
            }

            // If the current info is being just closed - add the watcher file to track changes
            // But if file was deleted, handle that part
            if (this.host.fileExists(info.fileName)) {
                this.watchClosedScriptInfo(info);
            }
            else {
                this.handleDeletedFile(info);
            }
        }

        private deleteOrphanScriptInfoNotInAnyProject() {
            this.filenameToScriptInfo.forEach(info => {
                if (!info.isScriptOpen() && info.containingProjects.length === 0) {
                    // if there are not projects that include this script info - delete it
                    this.stopWatchingScriptInfo(info, WatcherCloseReason.OrphanScriptInfo);
                    this.filenameToScriptInfo.delete(info.path);
                }
            });
        }

        private configFileExists(configFileName: NormalizedPath, canonicalConfigFilePath: string, info: ScriptInfo) {
            let configFilePresenceInfo = this.mapOfConfigFilePresence.get(canonicalConfigFilePath);
            if (configFilePresenceInfo) {
                // By default the info is belong to the config file.
                // Only adding the info as a root to inferred project will make it the root
                if (!configFilePresenceInfo.trackingOpenFilesMap.has(info.path)) {
                    configFilePresenceInfo.trackingOpenFilesMap.set(info.path, false);
                    this.logConfigFileWatchUpdate(configFileName, configFilePresenceInfo, ConfigFileWatcherStatus.TrackingFileAdded);
                }
                return configFilePresenceInfo.exists;
            }

            // Theorotically we should be adding watch for the directory here itself.
            // In practice there will be very few scenarios where the config file gets added
            // somewhere inside the another config file directory.
            // And technically we could handle that case in configFile's directory watcher in some cases
            // But given that its a rare scenario it seems like too much overhead. (we werent watching those directories earlier either)
            // So what we are now watching is: configFile if the project is open
            // And the whole chain of config files only for the inferred project roots

            // Cache the host value of file exists and add the info tio to the tracked root
            const trackingOpenFilesMap = createMap<boolean>();
            trackingOpenFilesMap.set(info.path, false);
            const exists = this.host.fileExists(configFileName);
            configFilePresenceInfo = { exists, trackingOpenFilesMap };
            this.mapOfConfigFilePresence.set(canonicalConfigFilePath, configFilePresenceInfo);
            this.logConfigFileWatchUpdate(configFileName, configFilePresenceInfo, ConfigFileWatcherStatus.TrackingFileAdded);
            return exists;
        }

        private setConfigFilePresenceByNewConfiguredProject(project: ConfiguredProject) {
            const configFilePresenceInfo = this.mapOfConfigFilePresence.get(project.canonicalConfigFilePath);
            if (configFilePresenceInfo) {
                Debug.assert(configFilePresenceInfo.exists);
                // close existing watcher
                if (configFilePresenceInfo.configFileWatcher) {
                    const configFileName = project.getConfigFilePath();
                    this.closeFileWatcher(
                        WatchType.ConfigFileForInferredRoot, /*project*/ undefined, configFileName,
                        configFilePresenceInfo.configFileWatcher, WatcherCloseReason.ConfigProjectCreated
                    );
                    configFilePresenceInfo.configFileWatcher = undefined;
                    this.logConfigFileWatchUpdate(configFileName, configFilePresenceInfo, ConfigFileWatcherStatus.UpdatedCallback);
                }
            }
            else {
                // We could be in this scenario if it is the external project tracked configured file
                // Since that route doesnt check if the config file is present or not
                this.mapOfConfigFilePresence.set(project.canonicalConfigFilePath, {
                    exists: true,
                    trackingOpenFilesMap: createMap<boolean>()
                });
            }
        }

        private configFileExistenceTracksInferredRoot(configFilePresenceInfo: ConfigFileExistence) {
            return forEachEntry(configFilePresenceInfo.trackingOpenFilesMap, (value, __key) => value);
        }

        private setConfigFilePresenceByClosedConfigFile(closedProject: ConfiguredProject) {
            const configFilePresenceInfo = this.mapOfConfigFilePresence.get(closedProject.canonicalConfigFilePath);
            Debug.assert(!!configFilePresenceInfo);
            const trackingOpenFilesMap = configFilePresenceInfo.trackingOpenFilesMap;
            if (trackingOpenFilesMap.size) {
                const configFileName = closedProject.getConfigFilePath();
                if (this.configFileExistenceTracksInferredRoot(configFilePresenceInfo)) {
                    Debug.assert(!configFilePresenceInfo.configFileWatcher);
                    configFilePresenceInfo.configFileWatcher = this.addFileWatcher(
                        WatchType.ConfigFileForInferredRoot, /*project*/ undefined, configFileName,
                        (_filename, eventKind) => this.onConfigFileChangeForOpenScriptInfo(configFileName, eventKind)
                    );
                    this.logConfigFileWatchUpdate(configFileName, configFilePresenceInfo, ConfigFileWatcherStatus.UpdatedCallback);
                }
            }
            else {
                // There is no one tracking anymore. Remove the status
                this.mapOfConfigFilePresence.delete(closedProject.canonicalConfigFilePath);
            }
        }

        private logConfigFileWatchUpdate(configFileName: NormalizedPath, configFilePresenceInfo: ConfigFileExistence, status: ConfigFileWatcherStatus) {
            if (this.logger.loggingEnabled()) {
                const inferredRoots: string[] = [];
                const otherFiles: string[] = [];
                configFilePresenceInfo.trackingOpenFilesMap.forEach((value, key: Path) => {
                    const info = this.getScriptInfoForPath(key);
                    if (value) {
                        inferredRoots.push(info.fileName);
                    }
                    else {
                        otherFiles.push(info.fileName);
                    }
                });
                const watchType = status === ConfigFileWatcherStatus.UpdatedCallback ||
                    status === ConfigFileWatcherStatus.ReloadingFiles ||
                    status === ConfigFileWatcherStatus.ReloadingInferredRootFiles ?
                    (configFilePresenceInfo.configFileWatcher ? WatchType.ConfigFileForInferredRoot : WatchType.ConfigFilePath) :
                    "";
                this.logger.info(`ConfigFilePresence ${watchType}:: File: ${configFileName} Currently Tracking: InferredRootFiles: ${inferredRoots} OtherFiles: ${otherFiles} Status: ${status}`);
            }
        }

        private closeConfigFileWatcherIfInferredRoot(configFileName: NormalizedPath, canonicalConfigFilePath: string,
            configFilePresenceInfo: ConfigFileExistence, infoIsInferredRoot: boolean, reason: WatcherCloseReason) {
            // Close the config file watcher if it was the last inferred root
            if (infoIsInferredRoot &&
                configFilePresenceInfo.configFileWatcher &&
                !this.configFileExistenceTracksInferredRoot(configFilePresenceInfo)) {
                this.closeFileWatcher(
                    WatchType.ConfigFileForInferredRoot, /*project*/ undefined, configFileName,
                    configFilePresenceInfo.configFileWatcher, reason
                );
                configFilePresenceInfo.configFileWatcher = undefined;
            }

            // If this was the last tracking file open for this config file, remove the cached value
            if (!configFilePresenceInfo.trackingOpenFilesMap.size &&
                !this.getConfiguredProjectByCanonicalConfigFilePath(canonicalConfigFilePath)) {
                this.mapOfConfigFilePresence.delete(canonicalConfigFilePath);
            }
        }

        private closeConfigFileWatchForClosedScriptInfo(configFileName: NormalizedPath, canonicalConfigFilePath: string, info: ScriptInfo) {
            const configFilePresenceInfo = this.mapOfConfigFilePresence.get(canonicalConfigFilePath);
            if (configFilePresenceInfo) {
                const isInferredRoot = configFilePresenceInfo.trackingOpenFilesMap.get(info.path);

                // Delete the info from tracking
                configFilePresenceInfo.trackingOpenFilesMap.delete(info.path);
                this.logConfigFileWatchUpdate(configFileName, configFilePresenceInfo, ConfigFileWatcherStatus.TrackingFileRemoved);

                // Close the config file watcher if it was the last inferred root
                this.closeConfigFileWatcherIfInferredRoot(configFileName, canonicalConfigFilePath,
                    configFilePresenceInfo, isInferredRoot, WatcherCloseReason.FileClosed
                );
            }
        }

        /**
         * This is called on file close, so that we stop watching the config file for this script info
         * @param info
         */
        private stopWatchingConfigFilesForClosedScriptInfo(info: ScriptInfo) {
            Debug.assert(!info.isScriptOpen());
            this.enumerateConfigFileLocations(info, (configFileName, canonicalConfigFilePath) =>
                this.closeConfigFileWatchForClosedScriptInfo(configFileName, canonicalConfigFilePath, info)
            );
        }

        private watchConfigFileForInferredProjectRoot(configFileName: NormalizedPath, canonicalConfigFilePath: string, info: ScriptInfo) {
            let configFilePresenceInfo = this.mapOfConfigFilePresence.get(canonicalConfigFilePath);
            if (!configFilePresenceInfo) {
                // Create the cache
                configFilePresenceInfo = {
                    exists: this.host.fileExists(configFileName),
                    trackingOpenFilesMap: createMap<boolean>()
                };
                this.mapOfConfigFilePresence.set(canonicalConfigFilePath, configFilePresenceInfo);
            }

            // Set this file as inferred root
            configFilePresenceInfo.trackingOpenFilesMap.set(info.path, true);
            this.logConfigFileWatchUpdate(configFileName, configFilePresenceInfo, ConfigFileWatcherStatus.InferredRootAdded);

            // If there is no configured project for this config file, create the watcher
            if (!configFilePresenceInfo.configFileWatcher &&
                !this.getConfiguredProjectByCanonicalConfigFilePath(canonicalConfigFilePath)) {
                configFilePresenceInfo.configFileWatcher = this.addFileWatcher(WatchType.ConfigFileForInferredRoot, /*project*/ undefined, configFileName,
                    (_fileName, eventKind) => this.onConfigFileChangeForOpenScriptInfo(configFileName, eventKind)
                );
                this.logConfigFileWatchUpdate(configFileName, configFilePresenceInfo, ConfigFileWatcherStatus.UpdatedCallback);
            }
        }

        /**
         * This is called by inferred project whenever script info is added as a root
         */
        /* @internal */
        startWatchingConfigFilesForInferredProjectRoot(info: ScriptInfo) {
            Debug.assert(info.isScriptOpen());
            this.enumerateConfigFileLocations(info, (configFileName, canonicalConfigFilePath) =>
                this.watchConfigFileForInferredProjectRoot(configFileName, canonicalConfigFilePath, info)
            );
        }

        private closeWatchConfigFileForInferredProjectRoot(configFileName: NormalizedPath, canonicalConfigFilePath: string, info: ScriptInfo, reason: WatcherCloseReason) {
            const configFilePresenceInfo = this.mapOfConfigFilePresence.get(canonicalConfigFilePath);
            if (configFilePresenceInfo) {
                // Set this as not inferred root
                if (configFilePresenceInfo.trackingOpenFilesMap.has(info.path)) {
                    configFilePresenceInfo.trackingOpenFilesMap.set(info.path, false);
                    this.logConfigFileWatchUpdate(configFileName, configFilePresenceInfo, ConfigFileWatcherStatus.InferredRootRemoved);
                }

                // Close the watcher if present
                this.closeConfigFileWatcherIfInferredRoot(configFileName, canonicalConfigFilePath,
                    configFilePresenceInfo, /*infoIsInferredRoot*/ true, reason
                );
            }
        }

        /**
         * This is called by inferred project whenever root script info is removed from it
         */
        /* @internal */
        stopWatchingConfigFilesForInferredProjectRoot(info: ScriptInfo, reason: WatcherCloseReason) {
            this.enumerateConfigFileLocations(info, (configFileName, canonicalConfigFilePath) =>
                this.closeWatchConfigFileForInferredProjectRoot(configFileName, canonicalConfigFilePath, info, reason)
            );
        }

        /**
         * This function tries to search for a tsconfig.json for the given file.
         * This is different from the method the compiler uses because
         * the compiler can assume it will always start searching in the
         * current directory (the directory in which tsc was invoked).
         * The server must start searching from the directory containing
         * the newly opened file.
         */
        private enumerateConfigFileLocations(info: ScriptInfo,
            action: (configFileName: NormalizedPath, canonicalConfigFilePath: string) => boolean | void,
            projectRootPath?: NormalizedPath) {
            let searchPath = asNormalizedPath(getDirectoryPath(info.fileName));

            while (!projectRootPath || searchPath.indexOf(projectRootPath) >= 0) {
                const canonicalSearchPath = normalizedPathToPath(searchPath, this.currentDirectory, this.toCanonicalFileName);
                const tsconfigFileName = asNormalizedPath(combinePaths(searchPath, "tsconfig.json"));
                let result = action(tsconfigFileName, combinePaths(canonicalSearchPath, "tsconfig.json"));
                if (result) {
                    return tsconfigFileName;
                }

                const jsconfigFileName = asNormalizedPath(combinePaths(searchPath, "jsconfig.json"));
                result = action(jsconfigFileName, combinePaths(canonicalSearchPath, "jsconfig.json"));
                if (result) {
                    return jsconfigFileName;
                }

                const parentPath = asNormalizedPath(getDirectoryPath(searchPath));
                if (parentPath === searchPath) {
                    break;
                }
                searchPath = parentPath;
            }

            return undefined;
        }

        /**
         * This function tries to search for a tsconfig.json for the given file.
         * This is different from the method the compiler uses because
         * the compiler can assume it will always start searching in the
         * current directory (the directory in which tsc was invoked).
         * The server must start searching from the directory containing
         * the newly opened file.
         */
        private getConfigFileNameForFile(info: ScriptInfo, projectRootPath?: NormalizedPath) {
            Debug.assert(info.isScriptOpen());
            this.logger.info(`Search path: ${getDirectoryPath(info.fileName)}`);
            const configFileName = this.enumerateConfigFileLocations(info,
                (configFileName: NormalizedPath, canonicalConfigFilePath: string) =>
                    this.configFileExists(configFileName, canonicalConfigFilePath, info),
                projectRootPath
            );
            if (configFileName) {
                this.logger.info(`For info: ${info.fileName} :: Config file name: ${configFileName}`);
            }
            else {
                this.logger.info(`For info: ${info.fileName} :: No config files found.`);
            }
            return configFileName;
        }

        private printProjects() {
            if (!this.logger.hasLevel(LogLevel.verbose)) {
                return;
            }

            this.logger.startGroup();

            let counter = 0;
            counter = printProjects(this.logger, this.externalProjects, counter);
            counter = printProjects(this.logger, arrayFrom(this.configuredProjects.values()), counter);
            counter = printProjects(this.logger, this.inferredProjects, counter);

            this.logger.info("Open files: ");
            for (const rootFile of this.openFiles) {
                this.logger.info(`\t${rootFile.fileName}`);
            }

            this.logger.endGroup();

            function printProjects(logger: Logger, projects: Project[], counter: number) {
                for (const project of projects) {
                    // Print shouldnt update the graph. It should emit whatever state the project is currently in
                    logger.info(`Project '${project.getProjectName()}' (${ProjectKind[project.projectKind]}) ${counter}`);
                    logger.info(project.filesToString());
                    logger.info("-----------------------------------------------");
                    counter++;
                }
                return counter;
            }
        }

        private findConfiguredProjectByProjectName(configFileName: NormalizedPath) {
            // make sure that casing of config file name is consistent
            const canonicalConfigFilePath = asNormalizedPath(this.toCanonicalFileName(configFileName));
            return this.getConfiguredProjectByCanonicalConfigFilePath(canonicalConfigFilePath);
        }

        private getConfiguredProjectByCanonicalConfigFilePath(canonicalConfigFilePath: string) {
            return this.configuredProjects.get(canonicalConfigFilePath);
        }

        private findExternalProjectByProjectName(projectFileName: string) {
            return findProjectByName(projectFileName, this.externalProjects);
        }

        private convertConfigFileContentToProjectOptions(configFilename: string, cachedServerHost: CachedServerHost) {
            configFilename = normalizePath(configFilename);

            const configFileContent = this.host.readFile(configFilename);

            const result = parseJsonText(configFilename, configFileContent);
            if (!result.endOfFileToken) {
                result.endOfFileToken = <EndOfFileToken>{ kind: SyntaxKind.EndOfFileToken };
            }
            const errors = result.parseDiagnostics;
            const parsedCommandLine = parseJsonSourceFileConfigFileContent(
                result,
                cachedServerHost,
                getDirectoryPath(configFilename),
                /*existingOptions*/ {},
                configFilename,
                /*resolutionStack*/[],
                this.hostConfiguration.extraFileExtensions);

            if (parsedCommandLine.errors.length) {
                errors.push(...parsedCommandLine.errors);
            }

            Debug.assert(!!parsedCommandLine.fileNames);

            const projectOptions: ProjectOptions = {
                files: parsedCommandLine.fileNames,
                compilerOptions: parsedCommandLine.options,
                configHasExtendsProperty: parsedCommandLine.raw["extends"] !== undefined,
                configHasFilesProperty: parsedCommandLine.raw["files"] !== undefined,
                configHasIncludeProperty: parsedCommandLine.raw["include"] !== undefined,
                configHasExcludeProperty: parsedCommandLine.raw["exclude"] !== undefined,
                wildcardDirectories: createMapFromTemplate(parsedCommandLine.wildcardDirectories),
                typeAcquisition: parsedCommandLine.typeAcquisition,
                compileOnSave: parsedCommandLine.compileOnSave
            };

            return { projectOptions, configFileErrors: errors, configFileSpecs: parsedCommandLine.configFileSpecs };
        }

        private exceededTotalSizeLimitForNonTsFiles<T>(name: string, options: CompilerOptions, fileNames: T[], propertyReader: FilePropertyReader<T>) {
            if (options && options.disableSizeLimit || !this.host.getFileSize) {
                return false;
            }

            let availableSpace = maxProgramSizeForNonTsFiles;
            this.projectToSizeMap.set(name, 0);
            this.projectToSizeMap.forEach(val => (availableSpace -= (val || 0)));

            let totalNonTsFileSize = 0;
            for (const f of fileNames) {
                const fileName = propertyReader.getFileName(f);
                if (hasTypeScriptFileExtension(fileName)) {
                    continue;
                }
                totalNonTsFileSize += this.host.getFileSize(fileName);
                if (totalNonTsFileSize > maxProgramSizeForNonTsFiles) {
                    // Keep the size as zero since it's disabled
                    return true;
                }
            }

            if (totalNonTsFileSize > availableSpace) {
                return true;
            }

            this.projectToSizeMap.set(name, totalNonTsFileSize);
            return false;
        }

        private createAndAddExternalProject(projectFileName: string, files: protocol.ExternalFile[], options: protocol.ExternalProjectCompilerOptions, typeAcquisition: TypeAcquisition) {
            const compilerOptions = convertCompilerOptions(options);
            const project = new ExternalProject(
                projectFileName,
                this,
                this.documentRegistry,
                compilerOptions,
                /*languageServiceEnabled*/ !this.exceededTotalSizeLimitForNonTsFiles(projectFileName, compilerOptions, files, externalFilePropertyReader),
                options.compileOnSave === undefined ? true : options.compileOnSave);

            this.addFilesToNonInferredProjectAndUpdateGraph(project, files, externalFilePropertyReader, /*clientFileName*/ undefined, typeAcquisition, /*configFileErrors*/ undefined);
            this.externalProjects.push(project);
            this.sendProjectTelemetry(project.externalProjectName, project);
            return project;
        }

        private sendProjectTelemetry(projectKey: string, project: server.ExternalProject | server.ConfiguredProject, projectOptions?: ProjectOptions): void {
            if (this.seenProjects.has(projectKey)) {
                return;
            }
            this.seenProjects.set(projectKey, true);

            if (!this.eventHandler) return;

            const data: ProjectInfoTelemetryEventData = {
                projectId: this.host.createHash(projectKey),
                fileStats: countEachFileTypes(project.getScriptInfos()),
                compilerOptions: convertCompilerOptionsForTelemetry(project.getCompilerOptions()),
                typeAcquisition: convertTypeAcquisition(project.getTypeAcquisition()),
                extends: projectOptions && projectOptions.configHasExtendsProperty,
                files: projectOptions && projectOptions.configHasFilesProperty,
                include: projectOptions && projectOptions.configHasIncludeProperty,
                exclude: projectOptions && projectOptions.configHasExcludeProperty,
                compileOnSave: project.compileOnSaveEnabled,
                configFileName: configFileName(),
                projectType: project instanceof server.ExternalProject ? "external" : "configured",
                languageServiceEnabled: project.languageServiceEnabled,
                version,
            };
            this.eventHandler({ eventName: ProjectInfoTelemetryEvent, data });

            function configFileName(): ProjectInfoTelemetryEventData["configFileName"] {
                if (!(project instanceof server.ConfiguredProject)) {
                    return "other";
                }

                const configFilePath = project instanceof server.ConfiguredProject && project.getConfigFilePath();
                const base = getBaseFileName(configFilePath);
                return base === "tsconfig.json" || base === "jsconfig.json" ? base : "other";
            }

            function convertTypeAcquisition({ enable, include, exclude }: TypeAcquisition): ProjectInfoTypeAcquisitionData {
                return {
                    enable,
                    include: include !== undefined && include.length !== 0,
                    exclude: exclude !== undefined && exclude.length !== 0,
                };
            }
        }

        private createAndAddConfiguredProject(configFileName: NormalizedPath, projectOptions: ProjectOptions, configFileErrors: Diagnostic[], configFileSpecs: ConfigFileSpecs, cachedServerHost: CachedServerHost, clientFileName?: string) {
            const languageServiceEnabled = !this.exceededTotalSizeLimitForNonTsFiles(configFileName, projectOptions.compilerOptions, projectOptions.files, fileNamePropertyReader);
            const project = new ConfiguredProject(
                configFileName,
                this,
                this.documentRegistry,
                projectOptions.configHasFilesProperty,
                projectOptions.compilerOptions,
                languageServiceEnabled,
                projectOptions.compileOnSave === undefined ? false : projectOptions.compileOnSave,
                cachedServerHost);

            project.configFileSpecs = configFileSpecs;
            // TODO: (sheetalkamat) We should also watch the configFiles that are extended
            project.configFileWatcher = this.addFileWatcher(WatchType.ConfigFilePath, project,
                configFileName, (_fileName, eventKind) => this.onConfigChangedForConfiguredProject(project, eventKind)
            );
            if (languageServiceEnabled) {
                project.watchWildcards(projectOptions.wildcardDirectories);
                project.watchTypeRoots();
            }

            this.addFilesToNonInferredProjectAndUpdateGraph(project, projectOptions.files, fileNamePropertyReader, clientFileName, projectOptions.typeAcquisition, configFileErrors);
            this.configuredProjects.set(project.canonicalConfigFilePath, project);
            this.setConfigFilePresenceByNewConfiguredProject(project);
            this.sendProjectTelemetry(project.getConfigFilePath(), project, projectOptions);
            return project;
        }

        private addFilesToNonInferredProjectAndUpdateGraph<T>(project: ConfiguredProject | ExternalProject, files: T[], propertyReader: FilePropertyReader<T>, clientFileName: string, typeAcquisition: TypeAcquisition, configFileErrors: Diagnostic[]): void {
            project.setProjectErrors(configFileErrors);
            this.updateNonInferredProjectFiles(project, files, propertyReader, clientFileName);
            project.setTypeAcquisition(typeAcquisition);
            // This doesnt need scheduling since its either creation or reload of the project
            project.updateGraph();
        }

        private openConfigFile(configFileName: NormalizedPath, clientFileName?: string) {
            const cachedServerHost = new CachedServerHost(this.host, this.toCanonicalFileName);
            const { projectOptions, configFileErrors, configFileSpecs } = this.convertConfigFileContentToProjectOptions(configFileName, cachedServerHost);
            this.logger.info(`Opened configuration file ${configFileName}`);
            return this.createAndAddConfiguredProject(configFileName, projectOptions, configFileErrors, configFileSpecs, cachedServerHost, clientFileName);
        }

        private updateNonInferredProjectFiles<T>(project: ExternalProject | ConfiguredProject, newUncheckedFiles: T[], propertyReader: FilePropertyReader<T>, clientFileName?: string) {
            const projectRootFilesMap = project.getRootFilesMap();
            const newRootScriptInfoMap: Map<ProjectRoot> = createMap<ProjectRoot>();

            for (const f of newUncheckedFiles) {
                const newRootFile = propertyReader.getFileName(f);
                const normalizedPath = toNormalizedPath(newRootFile);
                let scriptInfo: ScriptInfo | NormalizedPath;
                let path: Path;
                if (!project.lsHost.fileExists(newRootFile)) {
                    path = normalizedPathToPath(normalizedPath, this.currentDirectory, this.toCanonicalFileName);
                    const existingValue = projectRootFilesMap.get(path);
                    if (isScriptInfo(existingValue)) {
                        project.removeFile(existingValue);
                    }
                    projectRootFilesMap.set(path, normalizedPath);
                    scriptInfo = normalizedPath;
                }
                else {
                    const scriptKind = propertyReader.getScriptKind(f);
                    const hasMixedContent = propertyReader.hasMixedContent(f, this.hostConfiguration.extraFileExtensions);
                    scriptInfo = this.getOrCreateScriptInfoForNormalizedPath(normalizedPath, /*openedByClient*/ clientFileName === newRootFile, /*fileContent*/ undefined, scriptKind, hasMixedContent);
                    path = scriptInfo.path;
                    // If this script info is not already a root add it
                    if (!project.isRoot(scriptInfo)) {
                        project.addRoot(scriptInfo);
                        if (scriptInfo.isScriptOpen()) {
                            // if file is already root in some inferred project
                            // - remove the file from that project and delete the project if necessary
                            this.removeRootOfInferredProjectIfNowPartOfOtherProject(scriptInfo);
                        }
                    }
                }
                newRootScriptInfoMap.set(path, scriptInfo);
            }

            // project's root file map size is always going to be larger than new roots map
            // as we have already all the new files to the project
            if (projectRootFilesMap.size > newRootScriptInfoMap.size) {
                projectRootFilesMap.forEach((value, path) => {
                    if (!newRootScriptInfoMap.has(path)) {
                        if (isScriptInfo(value)) {
                            project.removeFile(value);
                        }
                        else {
                            projectRootFilesMap.delete(path);
                            project.markAsDirty();
                        }
                    }
                });
            }
            project.markAsDirty(); // Just to ensure that even if root files dont change, the changes to the non root file are picked up
        }

        private updateNonInferredProject<T>(project: ExternalProject | ConfiguredProject, newUncheckedFiles: T[], propertyReader: FilePropertyReader<T>, newOptions: CompilerOptions, newTypeAcquisition: TypeAcquisition, compileOnSave: boolean, configFileErrors: Diagnostic[]) {
            project.setCompilerOptions(newOptions);
            // VS only set the CompileOnSaveEnabled option in the request if the option was changed recently
            // therefore if it is undefined, it should not be updated.
            if (compileOnSave !== undefined) {
                project.compileOnSaveEnabled = compileOnSave;
            }
            this.addFilesToNonInferredProjectAndUpdateGraph(project, newUncheckedFiles, propertyReader, /*clientFileName*/ undefined, newTypeAcquisition, configFileErrors);
        }

        /**
         * Read the config file of the project again and update the project
         * @param project
         */
        /* @internal */
        reloadConfiguredProject(project: ConfiguredProject) {
            // At this point, there is no reason to not have configFile in the host

            // note: the returned "success" is true does not mean the "configFileErrors" is empty.
            // because we might have tolerated the errors and kept going. So always return the configFileErrors
            // regardless the "success" here is true or not.
            const host = project.getCachedServerHost();
            host.clearCache();
            const configFileName = project.getConfigFilePath();
            this.logger.info(`Reloading configured project ${configFileName}`);
            const { projectOptions, configFileErrors, configFileSpecs } = this.convertConfigFileContentToProjectOptions(configFileName, host);
            project.configFileSpecs = configFileSpecs;
            this.updateConfiguredProject(project, projectOptions, configFileErrors);

            if (!this.eventHandler) {
                return;
            }

            this.eventHandler(<ConfigFileDiagEvent>{
                eventName: ConfigFileDiagEvent,
                data: { configFileName, diagnostics: project.getGlobalProjectErrors() || [], triggerFile: configFileName }
            });
        }

        /**
         * Updates the configured project with updated config file contents
         * @param project
         */
        private updateConfiguredProject(project: ConfiguredProject, projectOptions: ProjectOptions, configFileErrors: Diagnostic[]) {
            if (this.exceededTotalSizeLimitForNonTsFiles(project.canonicalConfigFilePath, projectOptions.compilerOptions, projectOptions.files, fileNamePropertyReader)) {
                project.disableLanguageService();
                project.stopWatchingWildCards(WatcherCloseReason.ProjectReloadHitMaxSize);
                project.stopWatchingTypeRoots(WatcherCloseReason.ProjectReloadHitMaxSize);
            }
            else {
                project.enableLanguageService();
                project.watchWildcards(projectOptions.wildcardDirectories);
                project.watchTypeRoots();
            }
            this.updateNonInferredProject(project, projectOptions.files, fileNamePropertyReader, projectOptions.compilerOptions, projectOptions.typeAcquisition, projectOptions.compileOnSave, configFileErrors);
        }

        createInferredProjectWithRootFileIfNecessary(root: ScriptInfo) {
            const useExistingProject = this.useSingleInferredProject && this.inferredProjects.length;
            const project = useExistingProject
                ? this.inferredProjects[0]
                : new InferredProject(this, this.documentRegistry, this.compilerOptionsForInferredProjects);

            project.addRoot(root);
            project.updateGraph();

            if (!useExistingProject) {
                this.inferredProjects.push(project);
            }
            return project;
        }

        /**
         * @param uncheckedFileName is absolute pathname
         * @param fileContent is a known version of the file content that is more up to date than the one on disk
         */

        getOrCreateScriptInfo(uncheckedFileName: string, openedByClient: boolean, fileContent?: string, scriptKind?: ScriptKind) {
            return this.getOrCreateScriptInfoForNormalizedPath(toNormalizedPath(uncheckedFileName), openedByClient, fileContent, scriptKind);
        }

        getScriptInfo(uncheckedFileName: string) {
            return this.getScriptInfoForNormalizedPath(toNormalizedPath(uncheckedFileName));
        }

        private watchClosedScriptInfo(info: ScriptInfo) {
            Debug.assert(!info.fileWatcher);
            // do not watch files with mixed content - server doesn't know how to interpret it
            if (!info.hasMixedContent) {
                const { fileName } = info;
                info.fileWatcher = this.addFileWatcher(WatchType.ClosedScriptInfo, /*project*/ undefined, fileName,
                    (_fileName, eventKind) => this.onSourceFileChanged(fileName, eventKind)
                );
            }
        }

        private stopWatchingScriptInfo(info: ScriptInfo, reason: WatcherCloseReason) {
            if (info.fileWatcher) {
                this.closeFileWatcher(WatchType.ClosedScriptInfo, /*project*/ undefined, info.fileName, info.fileWatcher, reason);
                info.fileWatcher = undefined;
            }
        }

        getOrCreateScriptInfoForNormalizedPath(fileName: NormalizedPath, openedByClient: boolean, fileContent?: string, scriptKind?: ScriptKind, hasMixedContent?: boolean) {
            const path = normalizedPathToPath(fileName, this.currentDirectory, this.toCanonicalFileName);
            let info = this.getScriptInfoForPath(path);
            if (!info) {
                if (openedByClient || this.host.fileExists(fileName)) {
                    info = new ScriptInfo(this.host, fileName, scriptKind, hasMixedContent, path);

                    this.filenameToScriptInfo.set(info.path, info);

                    if (openedByClient) {
                        if (fileContent === undefined) {
                            // if file is opened by client and its content is not specified - use file text
                            fileContent = this.host.readFile(fileName) || "";
                        }
                    }
                    else {
                        this.watchClosedScriptInfo(info);
                    }
                }
            }
            if (info) {
                if (openedByClient && !info.isScriptOpen()) {
                    this.stopWatchingScriptInfo(info, WatcherCloseReason.FileOpened);
                    info.open(fileContent);
                    if (hasMixedContent) {
                        info.registerFileUpdate();
                    }
                }
                else if (fileContent !== undefined) {
                    info.reload(fileContent);
                }
            }
            return info;
        }

        getScriptInfoForNormalizedPath(fileName: NormalizedPath) {
            return this.getScriptInfoForPath(normalizedPathToPath(fileName, this.currentDirectory, this.toCanonicalFileName));
        }

        getScriptInfoForPath(fileName: Path) {
            return this.filenameToScriptInfo.get(fileName);
        }

        setHostConfiguration(args: protocol.ConfigureRequestArguments) {
            if (args.file) {
                const info = this.getScriptInfoForNormalizedPath(toNormalizedPath(args.file));
                if (info) {
                    info.setFormatOptions(convertFormatOptions(args.formatOptions));
                    this.logger.info(`Host configuration update for file ${args.file}`);
                }
            }
            else {
                if (args.hostInfo !== undefined) {
                    this.hostConfiguration.hostInfo = args.hostInfo;
                    this.logger.info(`Host information ${args.hostInfo}`);
                }
                if (args.formatOptions) {
                    mergeMapLikes(this.hostConfiguration.formatCodeOptions, convertFormatOptions(args.formatOptions));
                    this.logger.info("Format host information updated");
                }
                if (args.extraFileExtensions) {
                    this.hostConfiguration.extraFileExtensions = args.extraFileExtensions;
                    // We need to update the projects because of we might interprete more/less files
                    // depending on whether extra files extenstions are either added or removed
                    this.reloadProjects();
                    this.logger.info("Host file extension mappings updated");
                }
            }
        }

        /* @internal */
        closeFileWatcher(watchType: WatchType, project: Project, file: string, watcher: FileWatcher, reason: WatcherCloseReason) {
            this.logger.info(`FileWatcher:: Close: ${file} Project: ${project ? project.getProjectName() : ""} WatchType: ${watchType} Reason: ${reason}`);
            watcher.close();
        }

        /* @internal */
        addFileWatcher(watchType: WatchType, project: Project, file: string, cb: FileWatcherCallback) {
            this.logger.info(`FileWatcher:: Added: ${file} Project: ${project ? project.getProjectName() : ""} WatchType: ${watchType}`);
            return this.host.watchFile(file, (fileName, eventKind) => {
                this.logger.info(`FileWatcher:: File ${FileWatcherEventKind[eventKind]}: ${file} Project: ${project ? project.getProjectName() : ""} WatchType: ${watchType}`);
                cb(fileName, eventKind);
            });
        }

        /* @internal */
        closeDirectoryWatcher(watchType: WatchType, project: Project, directory: string, watcher: FileWatcher, recursive: boolean, reason: WatcherCloseReason) {
            this.logger.info(`DirectoryWatcher ${recursive ? "recursive" : ""}:: Close: ${directory} Project: ${project.getProjectName()} WatchType: ${watchType} Reason: ${reason}`);
            watcher.close();
        }

        /* @internal */
        addDirectoryWatcher(watchType: WatchType, project: Project, directory: string, cb: ServerDirectoryWatcherCallback, recursive: boolean) {
            this.logger.info(`DirectoryWatcher ${recursive ? "recursive" : ""}:: Added: ${directory} Project: ${project.getProjectName()} WatchType: ${watchType}`);
            return this.host.watchDirectory(directory, fileName => {
                const path = toNormalizedPath(getNormalizedAbsolutePath(fileName, directory));
                this.logger.info(`DirectoryWatcher:: EventOn: ${directory} Trigger: ${fileName} Path: ${path} Project: ${project.getProjectName()} WatchType: ${watchType}`);
                cb(path);
            }, recursive);
        }

        closeLog() {
            this.logger.close();
        }

        /**
         * This function rebuilds the project for every file opened by the client
         */
        reloadProjects() {
            this.logger.info("reload projects.");
            this.reloadConfiguredProjectForFiles(this.openFiles, /*delayReload*/ false);
            this.refreshInferredProjects();
        }

        delayReloadConfiguredProjectForFiles(openFilesMap: Map<boolean>, ignoreIfNotInferredProjectRoot: boolean) {
            // Get open files to reload projects for
            const openFiles = flatMapIter(openFilesMap.keys(), path => {
                if (!ignoreIfNotInferredProjectRoot || openFilesMap.get(path)) {
                    return this.getScriptInfoForPath(path as Path);
                }
            });
            this.reloadConfiguredProjectForFiles(openFiles, /*delayReload*/ true);
            this.delayInferredProjectsRefresh();
        }

        /**
         * This function goes through all the openFiles and tries to file the config file for them.
         * If the config file is found and it refers to existing project, it reloads it either immediately
         * or schedules it for reload depending on delayedReload option
         * If the there is no existing project it just opens the configured project for the config file
         */
        reloadConfiguredProjectForFiles(openFiles: ScriptInfo[], delayReload: boolean) {
            const mapUpdatedProjects = createMap<true>();
            // try to reload config file for all open files
            for (const info of openFiles) {
                // This tries to search for a tsconfig.json for the given file. If we found it,
                // we first detect if there is already a configured project created for it: if so,
                // we re- read the tsconfig file content and update the project only if we havent already done so
                // otherwise we create a new one.
                const configFileName = this.getConfigFileNameForFile(info);
                if (configFileName) {
                    let project = this.findConfiguredProjectByProjectName(configFileName);
                    if (!project) {
                        project = this.openConfigFile(configFileName, info.fileName);
                        mapUpdatedProjects.set(configFileName, true);
                    }
                    else if (!mapUpdatedProjects.has(configFileName)) {
                        if (delayReload) {
                            project.pendingReload = true;
                            this.delayUpdateProjectGraph(project);
                        }
                        else {
                            this.reloadConfiguredProject(project);
                        }
                        mapUpdatedProjects.set(configFileName, true);
                    }
                }
            }
        }

        /**
         *  - script info can be never migrate to state - root file in inferred project, this is only a starting point
         *  - if script info has more that one containing projects - it is not a root file in inferred project because:
         *    - references in inferred project supercede the root part
         *    - root/reference in non-inferred project beats root in inferred project
         */
        private removeRootOfInferredProjectIfNowPartOfOtherProject(info: ScriptInfo) {
            if (info.containingProjects.length > 1 &&
                info.containingProjects[0].projectKind === ProjectKind.Inferred &&
                info.containingProjects[0].isRoot(info)) {
                const inferredProject = info.containingProjects[0] as InferredProject;
                if (inferredProject.isProjectWithSingleRoot()) {
                    this.removeProject(inferredProject);
                }
                else {
                    inferredProject.removeFile(info);
                }
            }
        }

        /**
         * This function is to update the project structure for every projects.
         * It is called on the premise that all the configured projects are
         * up to date.
         */
        private refreshInferredProjects() {
            this.logger.info("refreshInferredProjects: updating project structure from ...");
            this.printProjects();

            for (const info of this.openFiles) {
                // collect all orphanted script infos from open files
                if (info.containingProjects.length === 0) {
                    this.assignScriptInfoToInferredProjectIfNecessary(info, /*addToListOfOpenFiles*/ false);
                }
                // Or remove the root of inferred project if is referenced in more than one projects
                else {
                    this.removeRootOfInferredProjectIfNowPartOfOtherProject(info);
                }
            }

            for (const p of this.inferredProjects) {
                p.updateGraph();
            }

            this.logger.info("refreshInferredProjects: updated project structure ...");
            this.printProjects();
        }

        /**
         * Open file whose contents is managed by the client
         * @param filename is absolute pathname
         * @param fileContent is a known version of the file content that is more up to date than the one on disk
         */
        openClientFile(fileName: string, fileContent?: string, scriptKind?: ScriptKind, projectRootPath?: string): OpenConfiguredProjectResult {
            return this.openClientFileWithNormalizedPath(toNormalizedPath(fileName), fileContent, scriptKind, /*hasMixedContent*/ false, projectRootPath ? toNormalizedPath(projectRootPath) : undefined);
        }

        openClientFileWithNormalizedPath(fileName: NormalizedPath, fileContent?: string, scriptKind?: ScriptKind, hasMixedContent?: boolean, projectRootPath?: NormalizedPath): OpenConfiguredProjectResult {
            let configFileName: NormalizedPath;
            let configFileErrors: Diagnostic[];

            const info = this.getOrCreateScriptInfoForNormalizedPath(fileName, /*openedByClient*/ true, fileContent, scriptKind, hasMixedContent);
            let project: ConfiguredProject | ExternalProject = this.findContainingExternalProject(fileName);
            if (!project) {
                configFileName = this.getConfigFileNameForFile(info, projectRootPath);
                if (configFileName) {
                    project = this.findConfiguredProjectByProjectName(configFileName);
                    if (!project) {
                        project = this.openConfigFile(configFileName, fileName);

                        // even if opening config file was successful, it could still
                        // contain errors that were tolerated.
                        const errors = project.getGlobalProjectErrors();
                        if (errors && errors.length > 0) {
                            // set configFileErrors only when the errors array is non-empty
                            configFileErrors = errors;
                        }
                    }
                }
            }
            if (project && !project.languageServiceEnabled) {
                // if project language service is disabled then we create a program only for open files.
                // this means that project should be marked as dirty to force rebuilding of the program
                // on the next request
                project.markAsDirty();
            }

            // at this point if file is the part of some configured/external project then this project should be created
            this.assignScriptInfoToInferredProjectIfNecessary(info, /*addToListOfOpenFiles*/ true);
            // Delete the orphan files here because there might be orphan script infos (which are not part of project)
            // when some file/s were closed which resulted in project removal.
            // It was then postponed to cleanup these script infos so that they can be reused if
            // the file from that old project is reopened because of opening file from here.
            this.deleteOrphanScriptInfoNotInAnyProject();
            this.printProjects();
            return { configFileName, configFileErrors };
        }

        /**
         * Close file whose contents is managed by the client
         * @param filename is absolute pathname
         */
        closeClientFile(uncheckedFileName: string) {
            const info = this.getScriptInfoForNormalizedPath(toNormalizedPath(uncheckedFileName));
            if (info) {
                this.closeOpenFile(info);
            }
            this.printProjects();
        }

        private collectChanges(lastKnownProjectVersions: protocol.ProjectVersionInfo[], currentProjects: Project[], result: ProjectFilesWithTSDiagnostics[]): void {
            for (const proj of currentProjects) {
                const knownProject = forEach(lastKnownProjectVersions, p => p.projectName === proj.getProjectName() && p);
                result.push(proj.getChangesSinceVersion(knownProject && knownProject.version));
            }
        }

        /* @internal */
        synchronizeProjectList(knownProjects: protocol.ProjectVersionInfo[]): ProjectFilesWithTSDiagnostics[] {
            const files: ProjectFilesWithTSDiagnostics[] = [];
            this.collectChanges(knownProjects, this.externalProjects, files);
            this.collectChanges(knownProjects, arrayFrom(this.configuredProjects.values()), files);
            this.collectChanges(knownProjects, this.inferredProjects, files);
            return files;
        }

        /* @internal */
        applyChangesInOpenFiles(openFiles: protocol.ExternalFile[], changedFiles: protocol.ChangedOpenFile[], closedFiles: string[]): void {
            if (openFiles) {
                for (const file of openFiles) {
                    const scriptInfo = this.getScriptInfo(file.fileName);
                    Debug.assert(!scriptInfo || !scriptInfo.isScriptOpen());
                    const normalizedPath = scriptInfo ? scriptInfo.fileName : toNormalizedPath(file.fileName);
                    this.openClientFileWithNormalizedPath(normalizedPath, file.content, tryConvertScriptKindName(file.scriptKind), file.hasMixedContent);
                }
            }

            if (changedFiles) {
                for (const file of changedFiles) {
                    const scriptInfo = this.getScriptInfo(file.fileName);
                    Debug.assert(!!scriptInfo);
                    // apply changes in reverse order
                    for (let i = file.changes.length - 1; i >= 0; i--) {
                        const change = file.changes[i];
                        scriptInfo.editContent(change.span.start, change.span.start + change.span.length, change.newText);
                    }
                    if (!this.changedFiles) {
                        this.changedFiles = [scriptInfo];
                    }
                    else if (this.changedFiles.indexOf(scriptInfo) < 0) {
                        this.changedFiles.push(scriptInfo);
                    }
                }
            }

            if (closedFiles) {
                for (const file of closedFiles) {
                    this.closeClientFile(file);
                }
            }
            // if files were open or closed then explicitly refresh list of inferred projects
            // otherwise if there were only changes in files - record changed files in `changedFiles` and defer the update
            if (openFiles || closedFiles) {
                this.ensureInferredProjectsUpToDate(/*refreshInferredProjects*/ true);
            }
        }

        private closeConfiguredProject(configFile: NormalizedPath): void {
            const configuredProject = this.findConfiguredProjectByProjectName(configFile);
            if (configuredProject && configuredProject.deleteOpenRef() === 0) {
                this.removeProject(configuredProject);
            }
        }

        closeExternalProject(uncheckedFileName: string, suppressRefresh = false): void {
            const fileName = toNormalizedPath(uncheckedFileName);
            const configFiles = this.externalProjectToConfiguredProjectMap.get(fileName);
            if (configFiles) {
                let shouldRefreshInferredProjects = false;
                for (const configFile of configFiles) {
                    if (this.closeConfiguredProject(configFile)) {
                        shouldRefreshInferredProjects = true;
                    }
                }
                this.externalProjectToConfiguredProjectMap.delete(fileName);
                if (shouldRefreshInferredProjects && !suppressRefresh) {
                    this.ensureInferredProjectsUpToDate(/*refreshInferredProjects*/ true);
                }
            }
            else {
                // close external project
                const externalProject = this.findExternalProjectByProjectName(uncheckedFileName);
                if (externalProject) {
                    this.removeProject(externalProject);
                    if (!suppressRefresh) {
                        this.ensureInferredProjectsUpToDate(/*refreshInferredProjects*/ true);
                    }
                }
            }
        }

        openExternalProjects(projects: protocol.ExternalProject[]): void {
            // record project list before the update
            const projectsToClose = arrayToMap(this.externalProjects, p => p.getProjectName(), _ => true);
            forEachKey(this.externalProjectToConfiguredProjectMap, externalProjectName => {
                projectsToClose.set(externalProjectName, true);
            });

            for (const externalProject of projects) {
                this.openExternalProject(externalProject, /*suppressRefreshOfInferredProjects*/ true);
                // delete project that is present in input list
                projectsToClose.delete(externalProject.projectFileName);
            }

            // close projects that were missing in the input list
            forEachKey(projectsToClose, externalProjectName => {
                this.closeExternalProject(externalProjectName, /*suppressRefresh*/ true);
            });

            this.ensureInferredProjectsUpToDate(/*refreshInferredProjects*/ true);
        }

        /** Makes a filename safe to insert in a RegExp */
        private static readonly filenameEscapeRegexp = /[-\/\\^$*+?.()|[\]{}]/g;
        private static escapeFilenameForRegex(filename: string) {
            return filename.replace(this.filenameEscapeRegexp, "\\$&");
        }

        resetSafeList(): void {
            this.safelist = defaultTypeSafeList;
        }

        loadSafeList(fileName: string): void {
            const raw: SafeList = JSON.parse(this.host.readFile(fileName, "utf-8"));
            // Parse the regexps
            for (const k of Object.keys(raw)) {
                raw[k].match = new RegExp(raw[k].match as {} as string, "i");
            }
            // raw is now fixed and ready
            this.safelist = raw;
        }

        applySafeList(proj: protocol.ExternalProject): void {
            const { rootFiles, typeAcquisition } = proj;
            const types = (typeAcquisition && typeAcquisition.include) || [];

            const excludeRules: string[] = [];

            const normalizedNames = rootFiles.map(f => normalizeSlashes(f.fileName));

            for (const name of Object.keys(this.safelist)) {
                const rule = this.safelist[name];
                for (const root of normalizedNames) {
                    if (rule.match.test(root)) {
                        this.logger.info(`Excluding files based on rule ${name}`);

                        // If the file matches, collect its types packages and exclude rules
                        if (rule.types) {
                            for (const type of rule.types) {
                                if (types.indexOf(type) < 0) {
                                    types.push(type);
                                }
                            }
                        }

                        if (rule.exclude) {
                            for (const exclude of rule.exclude) {
                                const processedRule = root.replace(rule.match, (...groups: Array<string>) => {
                                    return exclude.map(groupNumberOrString => {
                                        // RegExp group numbers are 1-based, but the first element in groups
                                        // is actually the original string, so it all works out in the end.
                                        if (typeof groupNumberOrString === "number") {
                                            if (typeof groups[groupNumberOrString] !== "string") {
                                                // Specification was wrong - exclude nothing!
                                                this.logger.info(`Incorrect RegExp specification in safelist rule ${name} - not enough groups`);
                                                // * can't appear in a filename; escape it because it's feeding into a RegExp
                                                return "\\*";
                                            }
                                            return ProjectService.escapeFilenameForRegex(groups[groupNumberOrString]);
                                        }
                                        return groupNumberOrString;
                                    }).join("");
                                });

                                if (excludeRules.indexOf(processedRule) === -1) {
                                    excludeRules.push(processedRule);
                                }
                            }
                        }
                        else {
                            // If not rules listed, add the default rule to exclude the matched file
                            const escaped = ProjectService.escapeFilenameForRegex(root);
                            if (excludeRules.indexOf(escaped) < 0) {
                                excludeRules.push(escaped);
                            }
                        }
                    }
                }

                // Copy back this field into the project if needed
                if (types.length > 0) {
                    proj.typeAcquisition = proj.typeAcquisition || {};
                    proj.typeAcquisition.include = types;
                }
            }

            const excludeRegexes = excludeRules.map(e => new RegExp(e, "i"));
            proj.rootFiles = proj.rootFiles.filter((_file, index) => !excludeRegexes.some(re => re.test(normalizedNames[index])));
        }

        openExternalProject(proj: protocol.ExternalProject, suppressRefreshOfInferredProjects = false): void {
            // typingOptions has been deprecated and is only supported for backward compatibility
            // purposes. It should be removed in future releases - use typeAcquisition instead.
            if (proj.typingOptions && !proj.typeAcquisition) {
                const typeAcquisition = convertEnableAutoDiscoveryToEnable(proj.typingOptions);
                proj.typeAcquisition = typeAcquisition;
            }

            this.applySafeList(proj);

            let tsConfigFiles: NormalizedPath[];
            const rootFiles: protocol.ExternalFile[] = [];
            for (const file of proj.rootFiles) {
                const normalized = toNormalizedPath(file.fileName);
                const baseFileName = getBaseFileName(normalized);
                if (baseFileName === "tsconfig.json" || baseFileName === "jsconfig.json") {
                    if (this.host.fileExists(normalized)) {
                        (tsConfigFiles || (tsConfigFiles = [])).push(normalized);
                    }
                }
                else {
                    rootFiles.push(file);
                }
            }

            // sort config files to simplify comparison later
            if (tsConfigFiles) {
                tsConfigFiles.sort();
            }

            const externalProject = this.findExternalProjectByProjectName(proj.projectFileName);
            let exisingConfigFiles: string[];
            if (externalProject) {
                if (!tsConfigFiles) {
                    const compilerOptions = convertCompilerOptions(proj.options);
                    if (this.exceededTotalSizeLimitForNonTsFiles(proj.projectFileName, compilerOptions, proj.rootFiles, externalFilePropertyReader)) {
                        externalProject.disableLanguageService();
                    }
                    else {
                        externalProject.enableLanguageService();
                    }
                    // external project already exists and not config files were added - update the project and return;
                    this.updateNonInferredProject(externalProject, proj.rootFiles, externalFilePropertyReader, compilerOptions, proj.typeAcquisition, proj.options.compileOnSave, /*configFileErrors*/ undefined);
                    return;
                }
                // some config files were added to external project (that previously were not there)
                // close existing project and later we'll open a set of configured projects for these files
                this.closeExternalProject(proj.projectFileName, /*suppressRefresh*/ true);
            }
            else if (this.externalProjectToConfiguredProjectMap.get(proj.projectFileName)) {
                // this project used to include config files
                if (!tsConfigFiles) {
                    // config files were removed from the project - close existing external project which in turn will close configured projects
                    this.closeExternalProject(proj.projectFileName, /*suppressRefresh*/ true);
                }
                else {
                    // project previously had some config files - compare them with new set of files and close all configured projects that correspond to unused files
                    const oldConfigFiles = this.externalProjectToConfiguredProjectMap.get(proj.projectFileName);
                    let iNew = 0;
                    let iOld = 0;
                    while (iNew < tsConfigFiles.length && iOld < oldConfigFiles.length) {
                        const newConfig = tsConfigFiles[iNew];
                        const oldConfig = oldConfigFiles[iOld];
                        if (oldConfig < newConfig) {
                            this.closeConfiguredProject(oldConfig);
                            iOld++;
                        }
                        else if (oldConfig > newConfig) {
                            iNew++;
                        }
                        else {
                            // record existing config files so avoid extra add-refs
                            (exisingConfigFiles || (exisingConfigFiles = [])).push(oldConfig);
                            iOld++;
                            iNew++;
                        }
                    }
                    for (let i = iOld; i < oldConfigFiles.length; i++) {
                        // projects for all remaining old config files should be closed
                        this.closeConfiguredProject(oldConfigFiles[i]);
                    }
                }
            }
            if (tsConfigFiles) {
                // store the list of tsconfig files that belong to the external project
                this.externalProjectToConfiguredProjectMap.set(proj.projectFileName, tsConfigFiles);
                for (const tsconfigFile of tsConfigFiles) {
                    let project = this.findConfiguredProjectByProjectName(tsconfigFile);
                    if (!project) {
                        // errors are stored in the project
                        project = this.openConfigFile(tsconfigFile);
                    }
                    if (project && !contains(exisingConfigFiles, tsconfigFile)) {
                        // keep project alive even if no documents are opened - its lifetime is bound to the lifetime of containing external project
                        project.addOpenRef();
                    }
                }
            }
            else {
                // no config files - remove the item from the collection
                this.externalProjectToConfiguredProjectMap.delete(proj.projectFileName);
                this.createAndAddExternalProject(proj.projectFileName, rootFiles, proj.options, proj.typeAcquisition);
            }
            if (!suppressRefreshOfInferredProjects) {
                this.ensureInferredProjectsUpToDate(/*refreshInferredProjects*/ true);
            }
        }
    }
}
