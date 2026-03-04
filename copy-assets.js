const fs = require('fs');
const path = require('path');

function copyIfExists(src, dest) {
    if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
    }
}

copyIfExists('src/public/index.html', 'dist/public/index.html');
copyIfExists('src/public/runner.html', 'dist/public/runner.html');
copyIfExists('src/public/style.css', 'dist/public/style.css');
copyIfExists('config.json', 'dist/config.json');
