#!/usr/bin/env node
import { main } from "./main.mjs";

process.exitCode = await main();
