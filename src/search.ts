const clear = require('clear');
import fs = require('fs');
import path = require('path');
import * as Collections from 'typescript-collections';
import readline = require('readline');
import colors = require('colors/safe');

const SEARCH_PATH = "C:\\projects";
const INCLUDE_PATTERN = /\.(js|ts|json)$/;
const EXCLUDE_PATTERN = /.git|venv|site-packages|vscode|android|grpc|cache|mypy/;

class IdMap<T> {
    private _map = new Map<T, number>();
    private _rmap = new Map<number, T>();
    private _idCounter = 0;

    getId(key: T): number {
        if (this._map.has(key)) return this._map.get(key);
        let newValue = this._idCounter++;
        this._map.set(key, newValue);
        this._rmap.set(newValue, key);
        return newValue;
    }

    getKey(id: number): T {
        return this._rmap.get(id);
    }

    serialize(): object {
        let result = [];
        for (let key of this._map.keys()) {
            result.push([key, this._map.get(key)]);
        }
        return result;
    }

    get size(): number {
        return this._idCounter;
    }

    static deserialize<U>(data: object): IdMap<U> {
        let result = new IdMap<U>();
        for (let [key, value] of data as Array<any>) {
            result._map.set(key, value);
            result._rmap.set(value, key);
            result._idCounter = Math.max(result._idCounter, value);
        }
        result._idCounter++;
        return result;
    }
}

type IndexCode = [number, number];
type PosList = Array<[number, number]>;

class FileIndex {
    private _fileIdMap = new IdMap<string>();
    private _codeMap = new Collections.DefaultDictionary<IndexCode, 
        Collections.Set<number>>( () => new Collections.Set<number>() );
    private _numEntries = 0;

    getFileId(fpath: string): number {
        return this._fileIdMap.getId(fpath);
    }

    addEntry(code: [number, number], fileId: number, pos: number) {
        if (this._codeMap.getValue(code).add(fileId))
            this._numEntries++;
    }

    get numberOfCodeEntries(): number {
        return this._codeMap.size();
    }

    get numberOfEntries(): number {
        return this._numEntries;
    }

    get numberOfFiles(): number {
        return this._fileIdMap.size;
    }

    search(query: string): Array<string> {
        if (query.length < 2) return [];

        let result: Collections.Set<number> = null;
        for (let i = 0; i < query.length - 1; i++) {
            let code = [query.charCodeAt( i ), query.charCodeAt( i + 1 )] as IndexCode;
            let currSet = this._codeMap.getValue( code );
            if (result === null) result = currSet;
            else {
                result.intersection(currSet);
                if (result.isEmpty()) break;
            }
        }
        return result.toArray().map( 
            fileId => this._fileIdMap.getKey( fileId ) );
    }

    save(fpath: string) {
        let content = JSON.stringify({
            fileIdMap: this._fileIdMap.serialize(),
            index: this._codeMap.keys().map(key => [key, this._codeMap.getValue( key ).toArray()]),
        });
        fs.writeFileSync(fpath, content);
    }

    static load(fpath: string): FileIndex {
        let fi = new FileIndex();
        let content = fs.readFileSync(fpath, 'utf8');
        let jsdata = JSON.parse(content);
        if (!jsdata) throw "Failed to load JSON file!";
        fi._fileIdMap = IdMap.deserialize(jsdata['fileIdMap']);
        for (let [code, indices] of jsdata['index']) {
            for (let idx of indices) {
                fi.addEntry(code, idx, 0);
            }
        }
        return fi;
    }
}

function* getFileEntries(root: string, includePattern?: RegExp, excludePattern?: RegExp): IterableIterator<string> {
    for (let entry of fs.readdirSync(root)) {
        let fpath = path.join(root, entry);
        let isDir = fs.statSync(fpath).isDirectory();
        if (isDir) {
            if (excludePattern && excludePattern.test(fpath)) continue;
            for (let entry of getFileEntries(fpath, includePattern, excludePattern))
                yield entry;
        }
        else {
            if (excludePattern && excludePattern.test(fpath)) continue;
            if (includePattern && !includePattern.test(fpath)) continue;
            yield fpath;
        }
    }
}

function indexFile(fidx: FileIndex, fpath: string) {
    console.log(`Indexing "${fpath}"...`);
    let fileId = fidx.getFileId(fpath);
    let content = fs.readFileSync(fpath, 'utf8');
    console.log(`File size: ${content.length}`);
    let prevCode = null;
    for (let i = 0; i < content.length; i++) {
        let code = content.charCodeAt(i);
        if (code <= 127) {
            if (prevCode !== null) {
                fidx.addEntry([prevCode, code], fileId, i - 1);
            }
            prevCode = code;
        }
        else {
            prevCode = null;
        }
    }
}

function makeIndex(): FileIndex {
    console.log( `Search path: ${SEARCH_PATH}` );
    let totalFiles = 0;
    let fileIndex = new FileIndex();
    // let excludePattern = /node_modules|.git|venv|site-packages|vscode|android|grpc|cache|mypy/;
    for (let s of getFileEntries( SEARCH_PATH, INCLUDE_PATTERN, EXCLUDE_PATTERN )) {
        //console.log(s);
        indexFile(fileIndex, s);
        totalFiles++;
        //if (totalFiles >= 10) break;
    }
    console.log( `Total files: ${totalFiles}` );
    console.log( `Total index entries: ${fileIndex.numberOfCodeEntries} -> ${fileIndex.numberOfEntries}` );
    return fileIndex;
}

let rl = null;
async function prompt(q: string): Promise<string> {
    if (!rl) {
        rl = readline.createInterface({ 
            input: process.stdin, 
            output: process.stdout,
            terminal: false });        
    }
    return new Promise<string>((resolve) => {
        rl.question(q, resolve);
    });
};

async function main() {
    clear();

    let fileIndex: FileIndex = null;
    try {
        console.log(colors.green("Loading index ...."));
        fileIndex = FileIndex.load( 'fs.index' );
    }
    catch (e) {
        console.log(colors.green("Index load unsuccessful. Creating new index ..."));
        fileIndex = makeIndex();
        fileIndex.save( 'fs.index' );
    }

    while (true) {
        let query = await prompt("?: ");
        if (query === 'exit') break;
        console.log( colors.blue( `Searching "${query}" ...` ) );
        let candidates = fileIndex.search( query );
        console.log( colors.green(`${candidates.length} candidates found in index of ${fileIndex.numberOfFiles} files.`));
        let results = [];
        for (let cand of candidates) {
            let content = fs.readFileSync( cand );
            if ( content.indexOf( query ) !== -1 )
                results.push( cand );
        }
        console.log( colors.green(`${results.length} results found.`));
        results.forEach( r => console.log(colors.yellow(r)) );
    }
    process.exit();
}
//main();

function countFiles(fpath: string, include: RegExp, exclude: RegExp): number {
    let total = 0;
    for (let s of getFileEntries(fpath, include, exclude)) {
        if (total % 100 == 0) {
            readline.clearLine(process.stdout, -1)
            readline.cursorTo(process.stdout, 0, null)
            process.stdout.write(`${total} ${s.length > 50 ? s.slice(s.length - 50) : s}`);
        } 
        total++;
    }
    return total;
}

function main2() {
    let count = countFiles(SEARCH_PATH, INCLUDE_PATTERN, EXCLUDE_PATTERN);
    console.log(`Number of files: ${count}`);
}

main2();


