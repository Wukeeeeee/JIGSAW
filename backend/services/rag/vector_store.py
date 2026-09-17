from typing import List,Tuple
import numpy as np

class VectorStore:
    def __init__(self):
        self.chunks:List[str]=[]
        self.vectors:List[np.ndarray]=[]

    def add(self,chunks:List[str],vectors:List[List[float]]):
        """批量存入chunk和对应的向量"""
        for chunk,vec in zip(chunks,vectors):
            self.chunks.append(chunk)
            self.vectors.append(np.array(vec))

    def search(self,query_vector:np.ndarray, top_k:int=5)->List[Tuple[str,float]]:
        """
        向量检索：
        输入查询向量，计算和库里所有向量的余弦相似度，返回top_k
        注意：我们embedding的时候已经normalize，所以直接点积=余弦相似度
        """
        q=np.array(query_vector)
        scores=[]
        for idx,vec in enumerate(self.vectors):
            sim=np.dot(q,vec)
            scores.append((self.chunks[idx],sim))

        scores.sort(key=lambda x:x[1],reverse=True)
        return scores[:top_k]
