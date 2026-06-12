require("dotenv").config();
const fs = require("fs");
fs.writeFileSync("startup-debug.log", "Step 1: dotenv loaded\nPORT=" + process.env.PORT + "\n");

try {
  const { app } = require("./src/server");
  fs.appendFileSync("startup-debug.log", "Step 2: server module loaded\n");
  
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    fs.appendFileSync("startup-debug.log", "Step 3: LISTENING on port " + port + "\n");
  });
  
  server.on("error", (e) => {
    fs.appendFileSync("startup-debug.log", "Step 3 ERROR: " + e.message + "\n");
  });
  
  setTimeout(() => {
    fs.appendFileSync("startup-debug.log", "Step 4: 3s passed, still alive\n");
  }, 3000);
  
} catch (e) {
  fs.appendFileSync("startup-debug.log", "FATAL: " + e.message + "\n" + e.stack + "\n");
}
