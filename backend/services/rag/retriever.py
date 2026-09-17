from typing import List,Tuple

class Retriever:
    def __init__(self,vector_store,embedding_model):
        """将外部传进来的两个实例保存成成员变量"""
        self.vector_store = vector_store
        self.embedding_model = embedding_model

    def keyword_search(self,query:str,chunks:list[str],top_k:int=5)->List[Tuple[str,int]]:
        """根据query和chunks，返回top_k个最相关的chunk和其对应的分数"""
        res=[]
        q_words=set(query)
        for chunk in chunks:
            cnt=sum([1 for word in q_words if word in chunk])
            res.append((chunk,cnt))

        """根据分数进行降序排序"""
        res.sort(key=lambda x:x[1],reverse=True)
        return res[:top_k]

    def vector_search(self,query:str,top_k:int=5)->List[Tuple[str,float]]:
        """根据query，返回top_k个最相关的chunk和其对应的分数"""
        query_vec=self.embedding_model.encode_single(query)
        return self.vector_store.search(query_vec,top_k)

    def rrf_fuse(self,vec_results:List[Tuple[str,float]],kw_results:List[Tuple[str,int]],k:int=60,final_top_k:int=5)->List[Tuple[str,float]]:
        """将vec_results和kw_results进行融合，返回top_k个最相关的chunk和其对应的分数"""
        rank_dict={}

        """处理向量检索结果"""
        for rank_idx,(chunk,_score) in enumerate(vec_results):
            rank=rank_idx+1
            rrf_score=1.0/(rank+k)
            if chunk not in rank_dict:
                rank_dict[chunk]=rrf_score
            else:
                rank_dict[chunk]+=rrf_score

        """处理关键词检索结果"""
        for rank_idx,(chunk,_score) in enumerate(kw_results):
            rank=rank_idx+1
            rrf_score=1.0/(rank+k)
            if chunk not in rank_dict:
                rank_dict[chunk]=rrf_score
            else:
                rank_dict[chunk]+=rrf_score

        """根据分数进行降序排序"""
        sorted_items = sorted(rank_dict.items(), key=lambda x:x[1], reverse=True)
        """返回前final_top_k个结果"""
        return sorted_items[:final_top_k]

    def retrieve(self, query:str, chunks:List[str], top_k:int=10, final_top_k:int=5) -> List[Tuple[str, float]]:
        """
        RAG检索总入口：
        1. 关键词检索召回 top_k 条候选
        2. 向量检索召回 top_k 条候选
        3. RRF融合两份榜单，返回最终 final_top_k 条chunk
        """
        # 1、关键词检索，拿出字面匹配榜单
        kw_results = self.keyword_search(query, chunks, top_k)
        # 2、向量检索，拿出语义匹配榜单
        vec_results = self.vector_search(query, top_k)
        # 3、RRF融合两份榜单
        fused_chunks = self.rrf_fuse(vec_results, kw_results, k=60, final_top_k=final_top_k)
        return fused_chunks
