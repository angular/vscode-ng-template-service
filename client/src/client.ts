/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as lsp from 'vscode-languageclient/node';

import {ProjectLoadingFinish, ProjectLoadingStart, SuggestStrictMode, SuggestStrictModeParams} from '../common/notifications';
import {NgccProgress, NgccProgressToken, NgccProgressType} from '../common/progress';
import {GetComponentsWithTemplateFile, GetTcbRequest, IsInAngularProject} from '../common/requests';

import {isInsideComponentDecorator, isInsideInlineTemplateRegion} from './embedded_support';
import {ProgressReporter} from './progress-reporter';

interface GetTcbResponse {
  uri: vscode.Uri;
  content: string;
  selections: vscode.Range[];
}

export class AngularLanguageClient implements vscode.Disposable {
  private client: lsp.LanguageClient|null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly outputChannel: vscode.OutputChannel;
  private readonly clientOptions: lsp.LanguageClientOptions;
  private readonly name = 'Angular Language Service';
  private readonly virtualDocumentContents = new Map<string, string>();
  /** A map that indicates whether Angular could be found in the file's project. */
  private readonly fileToIsInAngularProjectMap = new Map<string, boolean>();

  constructor(private readonly context: vscode.ExtensionContext) {
    vscode.workspace.registerTextDocumentContentProvider('angular-embedded-content', {
      provideTextDocumentContent: uri => {
        return this.virtualDocumentContents.get(uri.toString());
      }
    });

    this.outputChannel = vscode.window.createOutputChannel(this.name);
    // Options to control the language client
    this.clientOptions = {
      // Register the server for Angular templates and TypeScript documents
      documentSelector: [
        // scheme: 'file' means listen to changes to files on disk only
        // other option is 'untitled', for buffer in the editor (like a new doc)
        {scheme: 'file', language: 'html'},
        {scheme: 'file', language: 'typescript'},
      ],
      synchronize: {
        fileEvents: [
          // Notify the server about file changes to tsconfig.json contained in the workspace
          vscode.workspace.createFileSystemWatcher('**/tsconfig.json'),
        ]
      },
      // Don't let our output console pop open
      revealOutputChannelOn: lsp.RevealOutputChannelOn.Never,
      outputChannel: this.outputChannel,
      middleware: {
        provideDefinition: async (
            document: vscode.TextDocument, position: vscode.Position,
            token: vscode.CancellationToken, next: lsp.ProvideDefinitionSignature) => {
          if (await this.isInAngularProject(document) &&
              isInsideComponentDecorator(document, position)) {
            return next(document, position, token);
          }
        },
        provideTypeDefinition: async (
            document: vscode.TextDocument, position: vscode.Position,
            token: vscode.CancellationToken, next) => {
          if (await this.isInAngularProject(document) &&
              isInsideInlineTemplateRegion(document, position)) {
            return next(document, position, token);
          }
        },
        provideHover: async (
            document: vscode.TextDocument, position: vscode.Position,
            token: vscode.CancellationToken, next: lsp.ProvideHoverSignature) => {
          if (!(await this.isInAngularProject(document)) ||
              !isInsideInlineTemplateRegion(document, position)) {
            return;
          }

          const angularResultsPromise = next(document, position, token);

          const vdocUri = this.createVirtualHtmlDoc(document);
          const htmlProviderResultsPromise = vscode.commands.executeCommand<vscode.Hover[]>(
              'vscode.executeHoverProvider', vdocUri, position);

          const [angularResults, htmlProviderResults] =
              await Promise.all([angularResultsPromise, htmlProviderResultsPromise]);
          return angularResults ?? htmlProviderResults?.[0];
        },
        provideSignatureHelp: async (
            document: vscode.TextDocument, position: vscode.Position,
            context: vscode.SignatureHelpContext, token: vscode.CancellationToken,
            next: lsp.ProvideSignatureHelpSignature) => {
          if (await this.isInAngularProject(document) &&
              isInsideInlineTemplateRegion(document, position)) {
            return next(document, position, context, token);
          }
        },
        provideCompletionItem: async (
            document: vscode.TextDocument, position: vscode.Position,
            context: vscode.CompletionContext, token: vscode.CancellationToken,
            next: lsp.ProvideCompletionItemsSignature) => {
          // If not in inline template, do not perform request forwarding
          if (!(await this.isInAngularProject(document)) ||
              !isInsideInlineTemplateRegion(document, position)) {
            return;
          }
          const angularCompletionsPromise = next(document, position, context, token) as
              Promise<vscode.CompletionItem[]|null|undefined>;

          const vdocUri = this.createVirtualHtmlDoc(document);
          // This will not include angular stuff because the vdoc is not associated with an angular
          // component
          const htmlProviderCompletionsPromise =
              vscode.commands.executeCommand<vscode.CompletionList>(
                  'vscode.executeCompletionItemProvider', vdocUri, position,
                  context.triggerCharacter);
          const [angularCompletions, htmlProviderCompletions] =
              await Promise.all([angularCompletionsPromise, htmlProviderCompletionsPromise]);

          return [...(angularCompletions ?? []), ...(htmlProviderCompletions?.items ?? [])];
        }
      }
    };
  }

  private async isInAngularProject(doc: vscode.TextDocument): Promise<boolean> {
    if (this.client === null) {
      return false;
    }
    const uri = doc.uri.toString();
    if (this.fileToIsInAngularProjectMap.has(uri)) {
      return this.fileToIsInAngularProjectMap.get(uri)!;
    }

    try {
      const response = await this.client.sendRequest(IsInAngularProject, {
        textDocument: this.client.code2ProtocolConverter.asTextDocumentIdentifier(doc),
      });
      this.fileToIsInAngularProjectMap.set(uri, response);
      return response;
    } catch {
      return false;
    }
  }

  private createVirtualHtmlDoc(document: vscode.TextDocument): vscode.Uri {
    const originalUri = document.uri.toString();
    const vdocUri = vscode.Uri.file(encodeURIComponent(originalUri) + '.html')
                        .with({scheme: 'angular-embedded-content', authority: 'html'});
    this.virtualDocumentContents.set(vdocUri.toString(), document.getText());
    return vdocUri;
  }

  /**
   * Spin up the language server in a separate process and establish a connection.
   */
  async start(): Promise<void> {
    if (this.client !== null) {
      throw new Error(`An existing client is running. Call stop() first.`);
    }

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: lsp.ServerOptions = {
      run: getServerOptions(this.context, false /* debug */),
      debug: getServerOptions(this.context, true /* debug */),
    };

    // Create the language client and start the client.
    const forceDebug = process.env['NG_DEBUG'] === 'true';
    this.client = new lsp.LanguageClient(
        // This is the ID for Angular-specific configurations, like angular.log,
        // angular.ngdk, etc. See contributes.configuration in package.json.
        'angular',
        this.name,
        serverOptions,
        this.clientOptions,
        forceDebug,
    );
    this.disposables.push(this.client.start());
    await this.client.onReady();
    // Must wait for the client to be ready before registering notification
    // handlers.
    this.disposables.push(registerNotificationHandlers(this.client));
    this.disposables.push(registerProgressHandlers(this.client));
  }

  /**
   * Kill the language client and perform some clean ups.
   */
  async stop(): Promise<void> {
    if (this.client === null) {
      return;
    }
    await this.client.stop();
    this.outputChannel.clear();
    this.dispose();
    this.client = null;
  }

  /**
   * Requests a template typecheck block at the current cursor location in the
   * specified editor.
   */
  async getTcbUnderCursor(textEditor: vscode.TextEditor): Promise<GetTcbResponse|undefined> {
    if (this.client === null) {
      return undefined;
    }
    const c2pConverter = this.client.code2ProtocolConverter;
    // Craft a request by converting vscode params to LSP. The corresponding
    // response is in LSP.
    const response = await this.client.sendRequest(GetTcbRequest, {
      textDocument: c2pConverter.asTextDocumentIdentifier(textEditor.document),
      position: c2pConverter.asPosition(textEditor.selection.active),
    });
    if (response === null) {
      return undefined;
    }
    const p2cConverter = this.client.protocol2CodeConverter;
    // Convert the response from LSP back to vscode.
    return {
      uri: p2cConverter.asUri(response.uri),
      content: response.content,
      selections: p2cConverter.asRanges(response.selections),
    };
  }

  get initializeResult(): lsp.InitializeResult|undefined {
    return this.client?.initializeResult;
  }

  async getComponentsForOpenExternalTemplate(textEditor: vscode.TextEditor):
      Promise<vscode.Location[]|undefined> {
    if (this.client === null) {
      return undefined;
    }

    const response = await this.client.sendRequest(GetComponentsWithTemplateFile, {
      textDocument:
          this.client.code2ProtocolConverter.asTextDocumentIdentifier(textEditor.document),
    });
    if (response === undefined) {
      return undefined;
    }

    const p2cConverter = this.client.protocol2CodeConverter;
    return response.map(
        v => new vscode.Location(p2cConverter.asUri(v.uri), p2cConverter.asRange(v.range)));
  }

  dispose() {
    for (let d = this.disposables.pop(); d !== undefined; d = this.disposables.pop()) {
      d.dispose();
    }
  }
}

function registerNotificationHandlers(client: lsp.LanguageClient): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  disposables.push(client.onNotification(ProjectLoadingStart, () => {
    vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'Initializing Angular language features',
        },
        () => new Promise<void>((resolve) => {
          client.onNotification(ProjectLoadingFinish, resolve);
        }),
    );
  }));

  disposables.push(client.onNotification(SuggestStrictMode, async (params: SuggestStrictModeParams) => {
    const config = vscode.workspace.getConfiguration();
    if (config.get('angular.enable-strict-mode-prompt') === false) {
      return;
    }

    const openTsConfig = 'Open tsconfig.json';
    // Markdown is not generally supported in `showInformationMessage()`,
    // but links are supported. See
    // https://github.com/microsoft/vscode/issues/20595#issuecomment-281099832
    const doNotPromptAgain = 'Do not show again for this workspace';
    const selection = await vscode.window.showInformationMessage(
        'Some language features are not available. To access all features, enable ' +
            '[strictTemplates](https://angular.io/guide/angular-compiler-options#stricttemplates) in ' +
            '[angularCompilerOptions](https://angular.io/guide/angular-compiler-options).',
        openTsConfig,
        doNotPromptAgain,
    );
    if (selection === openTsConfig) {
      const document = await vscode.workspace.openTextDocument(params.configFilePath);
      vscode.window.showTextDocument(document);
    } else if (selection === doNotPromptAgain) {
      config.update(
          'angular.enable-strict-mode-prompt', false, vscode.ConfigurationTarget.Workspace);
    }
  }));

  return vscode.Disposable.from(...disposables);
}

function registerProgressHandlers(client: lsp.LanguageClient) {
  const progressReporters = new Map<string, ProgressReporter>();
  const disposable =
      client.onProgress(NgccProgressType, NgccProgressToken, async (params: NgccProgress) => {
        const {configFilePath} = params;
        if (!progressReporters.has(configFilePath)) {
          progressReporters.set(configFilePath, new ProgressReporter());
        }
        const reporter = progressReporters.get(configFilePath)!;
        if (params.done) {
          reporter.finish();
          progressReporters.delete(configFilePath);
          if (!params.success) {
            const selection = await vscode.window.showErrorMessage(
                `Angular extension might not work correctly because ngcc operation failed. ` +
                    `Try to invoke ngcc manually by running 'npm/yarn run ngcc'. ` +
                    `Please see the extension output for more information.`,
                'Show output',
            );
            if (selection) {
              client.outputChannel.show();
            }
          }
        } else {
          reporter.report(params.message);
        }
      });
  const reporterDisposer = vscode.Disposable.from({
    dispose() {
      for (const reporter of progressReporters.values()) {
        reporter.finish();
      }
      disposable.dispose();
    }
  });
  return reporterDisposer;
}

/**
 * Return the paths for the module that corresponds to the specified `configValue`,
 * and use the specified `bundled` as fallback if none is provided.
 * @param configName
 * @param bundled
 */
function getProbeLocations(configValue: string|null, bundled: string): string[] {
  const locations = [];
  // Always use config value if it's specified
  if (configValue) {
    locations.push(configValue);
  }
  // Prioritize the bundled version
  locations.push(bundled);
  // Look in workspaces currently open
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  for (const folder of workspaceFolders) {
    locations.push(folder.uri.fsPath);
  }
  return locations;
}

/**
 * Construct the arguments that's used to spawn the server process.
 * @param ctx vscode extension context
 */
function constructArgs(ctx: vscode.ExtensionContext): string[] {
  const config = vscode.workspace.getConfiguration();
  const args: string[] = ['--logToConsole'];

  const ngLog: string = config.get('angular.log', 'off');
  if (ngLog !== 'off') {
    // Log file does not yet exist on disk. It is up to the server to create the file.
    const logFile = path.join(ctx.logUri.fsPath, 'nglangsvc.log');
    args.push('--logFile', logFile);
    args.push('--logVerbosity', ngLog);
  }

  const ngdk: string|null = config.get('angular.ngdk', null);
  const ngProbeLocations = getProbeLocations(ngdk, ctx.extensionPath);
  args.push('--ngProbeLocations', ngProbeLocations.join(','));

  const viewEngine: boolean = config.get('angular.view-engine', false);
  if (viewEngine) {
    args.push('--viewEngine');
  }

  const tsdk: string|null = config.get('typescript.tsdk', null);
  const tsProbeLocations = getProbeLocations(tsdk, ctx.extensionPath);
  args.push('--tsProbeLocations', tsProbeLocations.join(','));

  return args;
}

function getServerOptions(ctx: vscode.ExtensionContext, debug: boolean): lsp.NodeModule {
  // Environment variables for server process
  const prodEnv = {};
  const devEnv = {
    ...prodEnv,
    NG_DEBUG: true,
  };

  // Node module for the language server
  const prodBundle = ctx.asAbsolutePath('server');
  const devBundle = ctx.asAbsolutePath(path.join('dist', 'server', 'server.js'));

  // Argv options for Node.js
  const prodExecArgv: string[] = [];
  const devExecArgv: string[] = [
    // do not lazily evaluate the code so all breakpoints are respected
    '--nolazy',
    // If debugging port is changed, update .vscode/launch.json as well
    '--inspect=6009',
  ];

  return {
    // VS Code Insider launches extensions in debug mode by default but users
    // install prod bundle so we have to check whether dev bundle exists.
    module: debug && fs.existsSync(devBundle) ? devBundle : prodBundle,
    transport: lsp.TransportKind.ipc,
    args: constructArgs(ctx),
    options: {
      env: debug ? devEnv : prodEnv,
      execArgv: debug ? devExecArgv : prodExecArgv,
    },
  };
}