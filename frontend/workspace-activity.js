// Keep announcements and the visual indicator in sync as the operation advances.
export function createWorkspaceActivity() {
  const status = document.createElement('div');
  status.className = 'workspace-activity';
  status.hidden = true;
  status.setAttribute('role','status');
  status.setAttribute('aria-atomic','true');
  status.setMessage = message => {
    status.hidden = !message;
    if (status.textContent !== message) status.textContent = message;
  };
  return status;
}
