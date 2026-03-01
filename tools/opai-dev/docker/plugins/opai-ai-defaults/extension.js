const vscode = require('vscode');

function activate(context) {
  // Open AI Chat panel after Theia finishes initializing
  setTimeout(() => {
    vscode.commands.executeCommand('aiChat:toggle').then(
      () => {},
      () => {
        // Fallback: try the view command
        vscode.commands.executeCommand('workbench.view.extension.ai-chat').catch(() => {});
      }
    );
  }, 3000);
}

function deactivate() {}

module.exports = { activate, deactivate };
