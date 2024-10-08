import * as THREE from 'three';
import { delayedExecute } from '../Util.js';
import { createSplatTreeWorker } from './SplatTreeWorker.js';

class SplatTreeNode {

    static idGen = 0;

    constructor(min, max, depth, id) {
        this.min = new THREE.Vector3().copy(min);
        this.max = new THREE.Vector3().copy(max);
        this.boundingBox = new THREE.Box3(this.min, this.max);
        this.center = new THREE.Vector3().copy(this.max).sub(this.min).multiplyScalar(0.5).add(this.min);
        this.depth = depth;
        this.children = [];
        this.data = null;
        this.id = id || SplatTreeNode.idGen++;
    }

}

class SplatSubTree {

    constructor(maxDepth, maxCentersPerNode) {
        this.maxDepth = maxDepth;
        this.maxCentersPerNode = maxCentersPerNode;
        this.sceneDimensions = new THREE.Vector3();
        this.sceneMin = new THREE.Vector3();
        this.sceneMax = new THREE.Vector3();
        this.rootNode = null;
        this.nodesWithIndexes = [];
        this.splatMesh = null;
    }

    static convertWorkerSubTreeNode(workerSubTreeNode) {
        const minVector = new THREE.Vector3().fromArray(workerSubTreeNode.min);
        const maxVector = new THREE.Vector3().fromArray(workerSubTreeNode.max);
        const convertedNode = new SplatTreeNode(minVector, maxVector, workerSubTreeNode.depth, workerSubTreeNode.id);
        if (workerSubTreeNode.data.indexes) {
            convertedNode.data = {
                'indexes': []
            };
            for (let index of workerSubTreeNode.data.indexes) {
                convertedNode.data.indexes.push(index);
            }
        }
        if (workerSubTreeNode.children) {
            for (let child of workerSubTreeNode.children) {
                convertedNode.children.push(SplatSubTree.convertWorkerSubTreeNode(child));
            }
        }
        return convertedNode;
    }

    static convertWorkerSubTree(workerSubTree, splatMesh) {
        const convertedSubTree = new SplatSubTree(workerSubTree.maxDepth, workerSubTree.maxCentersPerNode);
        convertedSubTree.sceneMin = new THREE.Vector3().fromArray(workerSubTree.sceneMin);
        convertedSubTree.sceneMax = new THREE.Vector3().fromArray(workerSubTree.sceneMax);

        convertedSubTree.splatMesh = splatMesh;
        convertedSubTree.rootNode = SplatSubTree.convertWorkerSubTreeNode(workerSubTree.rootNode);


        const visitLeavesFromNode = (node, visitFunc) => {
            if (node.children.length === 0) visitFunc(node);
            for (let child of node.children) {
                visitLeavesFromNode(child, visitFunc);
            }
        };

        convertedSubTree.nodesWithIndexes = [];
        visitLeavesFromNode(convertedSubTree.rootNode, (node) => {
            if (node.data && node.data.indexes && node.data.indexes.length > 0) {
                convertedSubTree.nodesWithIndexes.push(node);
            }
        });

        return convertedSubTree;
    }
}

function workerProcessCenters(splatTreeWorker, centers, transferBuffers, maxDepth, maxCentersPerNode) {
    splatTreeWorker.postMessage({
        'process': {
            'centers': centers,
            'maxDepth': maxDepth,
            'maxCentersPerNode': maxCentersPerNode
        }
    }, transferBuffers);
}

function checkAndCreateWorker() {
    const splatTreeWorker = new Worker(
        URL.createObjectURL(
            new Blob(['(', createSplatTreeWorker.toString(), ')(self)'], {
                type: 'application/javascript',
            }),
        ),
    );
    return splatTreeWorker;
}

/**
 * SplatTree: Octree tailored to splat data from a SplatMesh instance
 */
export class SplatTree {

    constructor(maxDepth, maxCentersPerNode) {
        this.maxDepth = maxDepth;
        this.maxCentersPerNode = maxCentersPerNode;
        this.subTrees = [];
        this.splatMesh = null;
    }


    dispose() {
        this.diposeSplatTreeWorker();
        this.disposed = true;
    }

    diposeSplatTreeWorker() {
        if (this.splatTreeWorker) this.splatTreeWorker.terminate();
        this.splatTreeWorker = null;
    };

    /**
     * Construct this instance of SplatTree from an instance of SplatMesh.
     *
     * @param {SplatMesh} splatMesh The instance of SplatMesh from which to construct this splat tree.
     * @param {function} filterFunc Optional function to filter out unwanted splats.
     * @param {function} onIndexesUpload Function to be called when the upload of splat centers to the splat tree
     *                                   builder worker starts and finishes.
     * @param {function} onSplatTreeConstruction Function to be called when the conversion of the local splat tree from
     *                                           the format produced by the splat tree builder worker starts and ends.
     * @return {undefined}
     */
    processSplatMesh = function(splatMesh, filterFunc = () => true, onIndexesUpload, onSplatTreeConstruction) {
        if (!this.splatTreeWorker) this.splatTreeWorker = checkAndCreateWorker();

        this.splatMesh = splatMesh;
        this.subTrees = [];
        const center = new THREE.Vector3();

        const addCentersForScene = (splatOffset, splatCount) => {
            const sceneCenters = new Float32Array(splatCount * 4);
            let addedCount = 0;
            for (let i = 0; i < splatCount; i++) {
                const globalSplatIndex = i + splatOffset;
                if (filterFunc(globalSplatIndex)) {
                    splatMesh.getSplatCenter(globalSplatIndex, center);
                    const addBase = addedCount * 4;
                    sceneCenters[addBase] = center.x;
                    sceneCenters[addBase + 1] = center.y;
                    sceneCenters[addBase + 2] = center.z;
                    sceneCenters[addBase + 3] = globalSplatIndex;
                    addedCount++;
                }
            }
            return sceneCenters;
        };

        return new Promise((resolve) => {

            const checkForEarlyExit = () => {
                if (this.disposed) {
                    this.diposeSplatTreeWorker();
                    resolve();
                    return true;
                }
                return false;
            };

            if (onIndexesUpload) onIndexesUpload(false);

            delayedExecute(() => {

                if (checkForEarlyExit()) return;

                const allCenters = [];
                if (splatMesh.dynamicMode) {
                    let splatOffset = 0;
                    for (let s = 0; s < splatMesh.scenes.length; s++) {
                        const scene = splatMesh.getScene(s);
                        const splatCount = scene.splatBuffer.getSplatCount();
                        const sceneCenters = addCentersForScene(splatOffset, splatCount);
                        allCenters.push(sceneCenters);
                        splatOffset += splatCount;
                    }
                } else {
                    const sceneCenters = addCentersForScene(0, splatMesh.getSplatCount());
                    allCenters.push(sceneCenters);
                }

                this.splatTreeWorker.onmessage = (e) => {

                    if (checkForEarlyExit()) return;

                    if (e.data.subTrees) {

                        if (onSplatTreeConstruction) onSplatTreeConstruction(false);

                        delayedExecute(() => {

                            if (checkForEarlyExit()) return;

                            for (let workerSubTree of e.data.subTrees) {
                                const convertedSubTree = SplatSubTree.convertWorkerSubTree(workerSubTree, splatMesh);
                                this.subTrees.push(convertedSubTree);
                            }
                            this.diposeSplatTreeWorker();

                            if (onSplatTreeConstruction) onSplatTreeConstruction(true);

                            delayedExecute(() => {
                                resolve();
                            });

                        });
                    }
                };

                delayedExecute(() => {
                    if (checkForEarlyExit()) return;
                    if (onIndexesUpload) onIndexesUpload(true);
                    const transferBuffers = allCenters.map((array) => array.buffer);
                    workerProcessCenters(this.splatTreeWorker, allCenters, transferBuffers, this.maxDepth, this.maxCentersPerNode);
                });

            });

        });

    };

    countLeaves() {

        let leafCount = 0;
        this.visitLeaves(() => {
            leafCount++;
        });

        return leafCount;
    }

    visitLeaves(visitFunc) {

        const visitLeavesFromNode = (node, visitFunc) => {
            if (node.children.length === 0) visitFunc(node);
            for (let child of node.children) {
                visitLeavesFromNode(child, visitFunc);
            }
        };

        for (let subTree of this.subTrees) {
            visitLeavesFromNode(subTree.rootNode, visitFunc);
        }
    }

}
