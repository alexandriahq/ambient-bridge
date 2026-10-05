import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const electronDist = fileURLToPath(new URL("../dist/electron", import.meta.url));
rmSync(electronDist, { recursive: true, force: true });
