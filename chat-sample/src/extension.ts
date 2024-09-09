import { contentType, renderElementJSON } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { CatToolPrompt } from './play';

export function activate(context: vscode.ExtensionContext) {
    registerChatTool(context);
    registerChatParticipant(context);
}

function registerChatTool(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.lm.registerTool('chat-sample_catVoice', {
        async invoke(options, token) {
            return {
                [contentType]: await renderElementJSON(CatToolPrompt, {}, options.tokenOptions, token),
                toString() {
                    return 'Reply in the voice of a cat! Use cat analogies when appropriate.';
                },
            };
        },
    }));

    interface ITabCountParameters {
        tabGroup?: number;
    }

    context.subscriptions.push(vscode.lm.registerTool('chat-sample_tabCount', {
        async invoke(options, token) {
            return {
                toString() {
                    const params = options.parameters as ITabCountParameters;
                    if (typeof params.tabGroup === 'number') {
                        const group = vscode.window.tabGroups.all[Math.max(params.tabGroup - 1, 0)];
                        const nth = params.tabGroup === 1 ? '1st' : params.tabGroup === 2 ? '2nd' : params.tabGroup === 3 ? '3rd' : `${params.tabGroup}th`;
                        return `There are ${group.tabs.length} tabs open in the ${nth} tab group.`;
                    } else {
                        const group = vscode.window.tabGroups.activeTabGroup;
                        return `There are ${group.tabs.length} tabs open.`;
                    }
                },
            };
        },
    }));
}

interface IToolCall {
    tool: vscode.LanguageModelToolDescription;
    call: vscode.LanguageModelChatResponseToolCallPart;
    result: Thenable<vscode.LanguageModelToolResult>;
}

function registerChatParticipant(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
        const models = await vscode.lm.selectChatModels({
            vendor: 'copilot',
            family: 'gpt-4o'
        });

        const model = models[0];
        stream.markdown(`Available tools: ${vscode.lm.tools.map(tool => tool.id).join(', ')}\n\n`);

        const allTools = vscode.lm.tools.map((tool): vscode.LanguageModelChatTool => {
            return {
                name: tool.id,
                description: tool.modelDescription,
                parametersSchema: tool.parametersSchema ?? {}
            };
        });

        const options: vscode.LanguageModelChatRequestOptions = {
            justification: 'Just because!',
        };

        const messages = [
            vscode.LanguageModelChatMessage.User(`There is a selection of tools that may give helpful context to answer the user's query. If you aren't sure which tool is relevant, you can call multiple tools.`),
            vscode.LanguageModelChatMessage.User(request.prompt),
        ];
        const toolReferences = [...request.toolReferences];
        const runWithFunctions = async (): Promise<void> => {
            const requestedTool = toolReferences.shift();
            if (requestedTool) {
                options.toolChoice = requestedTool.id;
                options.tools = allTools.filter(tool => tool.name === requestedTool.id);
            } else {
                options.toolChoice = undefined;
                options.tools = allTools;
            }

            const toolCalls: IToolCall[] = [];

            const response = await model.sendRequest(messages, options, token);

            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelChatResponseTextPart) {
                    stream.markdown(part.value);
                } else if (part instanceof vscode.LanguageModelChatResponseToolCallPart) {
                    const tool = vscode.lm.tools.find(tool => tool.id === part.name);
                    if (!tool) {
                        // BAD tool choice?
                        continue;
                    }

                    let parameters: any;
                    try {
                        parameters = JSON.parse(part.parameters);
                    } catch (err) {
                        throw new Error(`Got invalid tool use parameters: "${part.parameters}". (${(err as Error).message})`);
                    }

                    stream.progress(`Calling tool: ${tool.id} with ${part.parameters}`);
                    toolCalls.push({
                        call: part,
                        result: vscode.lm.invokeTool(tool.id, { parameters: JSON.parse(part.parameters) }, token),
                        tool
                    });
                }
            }

            if (toolCalls.length) {
                for (const toolCall of toolCalls) {
                    let assistantMsg = vscode.LanguageModelChatMessage.Assistant('');
                    assistantMsg.content2 = [new vscode.LanguageModelChatResponseToolCallPart(toolCall.tool.id, toolCall.call.toolCallId, toolCall.call.parameters)];
                    messages.push(assistantMsg);
    
                    // NOTE that the result of calling a function is a special content type of a USER-message
                    let message = vscode.LanguageModelChatMessage.User('');
                    message.content2 = [new vscode.LanguageModelChatMessageToolResultPart(toolCall.call.toolCallId, (await toolCall.result).toString())];
                    messages.push(message);
    
                }

                // IMPORTANT The prompt must end with a USER message (with no tool call)
                messages.push(vscode.LanguageModelChatMessage.User(`Above is the result of calling the functions ${toolCalls.map(call => call.tool.id).join(', ')}. The user cannot see this result, so you should explain it to the user if referencing it in your answer.`));
                
                // RE-enter
                return runWithFunctions();
            }
        };

        await runWithFunctions();
    };

    const toolUser = vscode.chat.createChatParticipant('chat-sample.tools', handler);
    toolUser.iconPath = new vscode.ThemeIcon('tools');
    context.subscriptions.push(toolUser);
}


export function deactivate() { }
