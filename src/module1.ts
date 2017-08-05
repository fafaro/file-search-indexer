import * as readline from 'readline';
import * as pathlib from 'path';
import * as fs from 'fs';
import * as EventEmitter from 'events';
import * as Collections from 'typescript-collections';

namespace myconsole {
    export function clrscr() {
        readline.cursorTo(process.stdout, 0, 0);
        readline.clearScreenDown(process.stdout);
    }

    export function print(s: string) {
        process.stdout.write(s);
    }

    export function println(s: string) {
        print(s + "\n");
    }

    export function log(obj: any) {
        console.log( obj );
    }
}

function countFilesRecursive(path1: string): number {
    let path2 = pathlib.resolve( path1 );

    function countFolder( path1: string ): number {
        let entries = fs.readdirSync( path1 );
        let total = 0;
        for (let entry of entries) {
            let entryPath = pathlib.join( path1, entry );
            if (fs.statSync( entryPath ).isDirectory())
                total += countFolder( entryPath );
            else
                total++;
        }
        return total;
    }

    return countFolder( path2 );
}

function countFilesRecursive2(path1: string): IterableIterator<number> {
    let path2 = pathlib.resolve( path1 );

    function *countFolder( path1: string ): IterableIterator<number> {
        let entries = fs.readdirSync( path1 );
        let total = 0;
        for (let entry of entries) {
            let entryPath = pathlib.join( path1, entry );
            if (fs.statSync( entryPath ).isDirectory()) {
                let result = 0;
                for (let r of countFolder( entryPath )) {
                    yield total + r;
                    result = r;
                }
                total += result;
            }
            else {
                total++;
                yield total;
            }
        }
        //return total;
    }

    return countFolder( path2 );
}

class DirectoryWalker extends EventEmitter {
    private _rootPath: string;
    private _worker: IterableIterator<any>;
    private _currentPath: string = null;
    private _fileCount: number = 0;
    private _followSymLinks: boolean = false;

    constructor(path: string) {
        super();
        this._rootPath = pathlib.resolve( path );
        this._worker = this.walkDirectory( this._rootPath );
    }

    get rootPath(): string { return this._rootPath; }
    get fileCount(): number { return this._fileCount; }
    get currentPath(): string { return this._currentPath; }

    doWork(): boolean {
        if (!this._worker) return false;
        let r = this._worker.next();
        if (r.done) {
            this._worker = null;
            return false;
        }
        return true;
    }

    private *walkDirectory(path: string) {
        for (let entry of fs.readdirSync( path )) {
            let path2 = pathlib.join( path, entry );
            let stat = fs.lstatSync( path2 );
            if (stat.isDirectory() || stat.isSymbolicLink()) {
                if (stat.isSymbolicLink() && !this._followSymLinks) continue;
                let childWorker = this.walkDirectory( path2 );
                while (!childWorker.next().done) yield;
            }
            else {
                this._fileCount++;
                this._currentPath = path2;
                this.emit("newentry", this._currentPath, stat);
                yield;
            }
        }
    }
}

class DirectoryTree {
    private _rootPath: string;
    private _rootNode: DirectoryTree.Node;
    //private _entries = [];

    constructor(walker: DirectoryWalker) {
        this.addEntry = this.addEntry.bind( this );

        this._rootPath = walker.rootPath;
        this._rootNode = new DirectoryTree.Node( '.', DirectoryTree.NodeType.Directory );
        walker.addListener("newentry", this.addEntry);
    }

    addEntry(path: string, stat: fs.Stats) {
        //this._entries.push( path );
        const DIR = DirectoryTree.NodeType.Directory;
        const FILE = DirectoryTree.NodeType.File;
        let relPath = pathlib.relative( this._rootPath, path );
        let parsedPath = pathlib.parse( relPath );
        let dirPath = parsedPath.dir === '' ? [] : parsedPath.dir.split( pathlib.sep ); 

        let currNode = this._rootNode;
        for (let dirComp of dirPath) {
            currNode = currNode.createChild( dirComp, DIR );
        }
        let child = currNode.createChild( parsedPath.base, FILE );
        child.size = stat.size;
    }

    print() {
        let totalSize = 0;
        const println = myconsole.println;
        function makeIndent(indent: number) {
            return "  ".repeat( indent );
        }
        function printNode(node: DirectoryTree.Node, indent: number = 0) {
            let ind = makeIndent( indent );
            println(`${ind}${node.name}`);
            if (node.type == DirectoryTree.NodeType.Directory) {
                for (let child of node.children) {
                    printNode( child, indent + 1 );
                }
            }
            else if (node.type == DirectoryTree.NodeType.File) {
                totalSize += node.size;
            }
        }
        printNode( this._rootNode );
        println(`Total size: ${totalSize}`);
    }

    iterateFiles(): IterableIterator<DirectoryTree.Node> {
        type DTNode = DirectoryTree.Node;
        type NodeStream = IterableIterator<DTNode>;
        const DIR = DirectoryTree.NodeType.Directory;
        const FILE = DirectoryTree.NodeType.File;

        function *iterFiles(node: DTNode): NodeStream {
            if (node.type == DIR) {
                for (let child of node.children) {
                    let iter = iterFiles( child );
                    let r: IteratorResult<DTNode>;
                    while ( !(r = iter.next()).done ) 
                        yield r.value;
                }
            }
            else if (node.type == FILE) {
                yield node;
            }
        }
        return iterFiles( this._rootNode );
    }

    numFiles(): number {
        let total = 0;
        for (let fileNode of this.iterateFiles())
            total++;
        return total;
    }

    totalSize(): number {
        let total = 0;
        for (let fileNode of this.iterateFiles())
            total += fileNode.size;
        return total;
    }
}

module DirectoryTree {
    export enum NodeType { File, Directory };

    export class Node {
        private _name: string;
        private _type: DirectoryTree.NodeType;
        private _children = new Collections.Dictionary<string, Node>();
        private _size = 0;

        constructor(name: string, type: DirectoryTree.NodeType) {
            this._name = name;
            this._type = type;
        }

        get name() { return this._name; }
        get children() { return this._children.values(); }
        get size() { return this._size; }
        set size(value: number) { this._size = value; }
        get type() { return this._type; }

        createChild(name: string, type: DirectoryTree.NodeType): Node {
            let child = this._children.getValue( name );
            if (child) return child;
            child = new Node( name, type );
            this._children.setValue( name, child );
            return child;
        }
    }
}

class Debouncer {
    private _interval: number = 0;
    private _lastTick = 0;

    constructor(ms: number) {
        this._interval = ms;
    }

    tick(): boolean {
        let currTime = Date.now();
        if (this._lastTick == 0 || currTime - this._lastTick >= this._interval) {
            this._lastTick = currTime;
            return true;
        }
        return false;
    }
}

function main() {
    myconsole.clrscr();
    myconsole.println( "Program has started. " );

    let path = 'c:\\projects\\smallworld';
    // let path = 'c:\\projects';
    // let path = '.';
    let dw = new DirectoryWalker( path );
    let cache = new DirectoryTree( dw );
    let deb = new Debouncer( 1000 / 24 );
    let printDwStatus = () => {
        function compressPath(path: string): string {
            if (path.length <= 50) return path;
            return path.slice(path.length - 50);
        }
        readline.clearLine(process.stdout, -1);
        readline.cursorTo(process.stdout, 0, undefined);
        myconsole.print( `[${dw.fileCount}] ${compressPath(dw.currentPath)}` );
    };
    while (dw.doWork())
        if (deb.tick()) 
            printDwStatus();
    printDwStatus();
    myconsole.println('');
    //cache.print();
    //global.gc();
    //console.log( process.memoryUsage() );
    function toMB(num: number): string {
        return (num / (1024 * 1024)).toFixed(2);
    }
    myconsole.println( `Total size: ${toMB(cache.totalSize())} MB` );
    myconsole.println( `Number of files: ${cache.numFiles()}` );
}

function main1() {
    myconsole.clrscr();
    myconsole.println( "Program has started." );

    function* limitPrinter(n: number) {
        let ctr = 0;
        let m;
        let lastMsg = null;
        while (m = yield) {
            if (ctr % n == 0) {
                myconsole.println( m );
                lastMsg = null;
            }
            else {
                lastMsg = m;
            }
            ctr++;
        }
        if (lastMsg)
            myconsole.println( lastMsg );
    }    

    // let path = ".";
    let path = "C:\\projects";
    // let nfiles = countFilesRecursive2( path );
    // console.println( `"${path}" has ${nfiles} files.` );
    let fb = countFilesRecursive2( path );
    let lprint = limitPrinter( 10 );
    lprint.next();
    for (let r of fb) {
        lprint.next( String(r) );
    }
    lprint.next( null );
}
main();