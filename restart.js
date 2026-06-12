require("dotenv").config();
const fs = require("fs");

try {
  const { app } = require("./src/server");
  const port = process.env.PORT || 3007;
  const server = app.listen(port, () => {
    fs.appendFileSync("startup-debug.log", `[${new Date().toISOString()}] RESTART: listening ${port}\n`);
  });
  server.on("error", (e) => fs.appendFileSync("startup-debug.log", `RESTART ERROR: ${e.message}\n`));
} catch (e) {
  fs.appendFileSync("startup-debug.log", `RESTART FATAL: ${e.message}\n`);
}
