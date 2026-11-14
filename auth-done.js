// Try to close the sign-in window; browsers only allow it for windows a script opened.
setTimeout(() => { try { window.close(); } catch { /* ignore */ } }, 800);
