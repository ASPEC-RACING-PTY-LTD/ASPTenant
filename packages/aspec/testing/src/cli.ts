#!/usr/bin/env node
import { runScaffoldCli } from './scaffold.js';

const code = await runScaffoldCli(process.argv.slice(2));
process.exitCode = code;
