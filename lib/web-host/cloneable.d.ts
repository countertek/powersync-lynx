export declare const AB_TAG = "__psAb";
export declare const BIG_TAG = "__psBig";
export interface TaggedArrayBuffer {
    readonly __psAb: true;
    readonly u8: number[];
}
export interface TaggedBigInt {
    readonly __psBig: true;
    readonly v: string;
}
export interface CloneableObject {
    readonly [key: string]: Cloneable | undefined;
}
export type Cloneable = null | undefined | string | number | boolean | bigint | ArrayBuffer | Cloneable[] | TaggedArrayBuffer | TaggedBigInt | CloneableObject;
export declare function asCloneable(value: CloneableObject | Cloneable[] | TaggedArrayBuffer | TaggedBigInt): Cloneable;
export declare function asCloneableObject(value: CloneableObject): CloneableObject;
export declare function encodeCloneable(value: Cloneable): Cloneable;
export declare function decodeCloneable(value: Cloneable): Cloneable;
