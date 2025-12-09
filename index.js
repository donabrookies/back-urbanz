import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';

const app = express();

// Configuração do Supabase - Vercel usa variáveis de ambiente
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ ERRO: Variáveis de ambiente SUPABASE_URL e SUPABASE_KEY não configuradas!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware otimizado para Vercel
app.use(cors({
  origin: ['https://seusite.com', 'http://localhost:3000'], // Altere para seu domínio
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Cache otimizado para Vercel
let cache = {
  products: null,
  productsTimestamp: 0
};

const CACHE_DURATION = 2 * 60 * 1000; // 2 minutos

// Função para criptografar
function simpleEncrypt(text) {
  return Buffer.from(text).toString('base64').split('').reverse().join('');
}

// Função para descriptografar
function simpleDecrypt(encrypted) {
  return Buffer.from(encrypted.split('').reverse().join(''), 'base64').toString('utf8');
}

// Normalizar categorias
function normalizeCategories(categories) {
  if (!Array.isArray(categories)) return [];
  
  return categories.map(cat => {
    if (typeof cat === 'string') {
      return {
        id: cat,
        name: cat.charAt(0).toUpperCase() + cat.slice(1),
        description: `Categoria de ${cat}`
      };
    }
    if (cat && typeof cat === 'object' && cat.id) {
      return {
        id: cat.id,
        name: cat.name || cat.id.charAt(0).toUpperCase() + cat.id.slice(1),
        description: cat.description || `Categoria de ${cat.name || cat.id}`
      };
    }
    return null;
  }).filter(cat => cat !== null);
}

// Normalizar produtos
function normalizeProducts(products) {
  if (!Array.isArray(products)) return [];
  
  return products.map(product => {
    if (product.sizes && !product.colors) {
      return {
        ...product,
        colors: [
          {
            name: product.color || 'Padrão',
            image: product.image || 'https://via.placeholder.com/400x300',
            sizes: product.sizes
          }
        ]
      };
    }
    
    if (product.colors && Array.isArray(product.colors)) {
      return {
        ...product,
        colors: product.colors.map(color => ({
          name: color.name || 'Sem nome',
          image: color.image || 'https://via.placeholder.com/400x300',
          sizes: color.sizes || []
        }))
      };
    }
    
    return product;
  });
}

// Verificar autenticação
function checkAuth(token) {
  return token === "authenticated_admin_token";
}

// Limpar cache
function clearCache() {
  cache = {
    products: null,
    productsTimestamp: 0
  };
  console.log('🔄 Cache limpo');
}

// Migrar dados para o Supabase
async function migrateDataToSupabase() {
  try {
    console.log('🔄 Verificando dados iniciais no Supabase...');
    
    const adminPassword = 'admin123';
    const encryptedPassword = simpleEncrypt(adminPassword);
    
    const { data: existingCreds, error: credsError } = await supabase
      .from('admin_credentials')
      .select('id')
      .limit(1);

    if (credsError || !existingCreds || existingCreds.length === 0) {
      const { error } = await supabase
        .from('admin_credentials')
        .insert([{
          username: 'admin',
          password: adminPassword,
          encrypted_password: encryptedPassword
        }]);

      if (error) console.log('⚠️  Aviso nas credenciais:', error.message);
    }

    console.log('✅ Dados verificados!');
  } catch (error) {
    console.error('❌ Erro durante migração:', error.message);
  }
}

// ENDPOINTS DA API

// Health check (importante para Vercel)
app.get("/", (req, res) => {
  res.json({ 
    message: "🚀 Backend UrbanZ rodando no Vercel!", 
    status: "OK",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Autenticação
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    
    console.log('🔐 Tentativa de login:', username);

    const { data: credentials, error } = await supabase
      .from('admin_credentials')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !credentials) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const encryptedPassword = simpleEncrypt(password);
    
    if (encryptedPassword === credentials.encrypted_password || password === credentials.password) {
      res.json({ 
        success: true, 
        token: "authenticated_admin_token", 
        user: { username: username } 
      });
    } else {
      res.status(401).json({ error: "Credenciais inválidas" });
    }
  } catch (error) {
    console.error("❌ Erro no login:", error);
    res.status(500).json({ error: "Erro no processo de login" });
  }
});

// Buscar produtos com cache
app.get("/api/products", async (req, res) => {
  try {
    // Cache headers
    res.set({
      'Cache-Control': 'public, max-age=120',
      'X-Content-Type-Options': 'nosniff'
    });

    // Verificar cache
    const now = Date.now();
    if (cache.products && (now - cache.productsTimestamp) < CACHE_DURATION) {
      console.log('📦 Retornando produtos do cache');
      return res.json({ products: cache.products });
    }

    console.log('🔄 Buscando produtos do banco...');
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .order('id');

    if (error) {
      console.error("❌ Erro Supabase produtos:", error.message);
      return res.json({ products: [] });
    }

    const normalizedProducts = normalizeProducts(products || []);

    // Atualizar cache
    cache.products = normalizedProducts;
    cache.productsTimestamp = now;

    res.json({ products: normalizedProducts });
  } catch (error) {
    console.error("❌ Erro ao buscar produtos:", error);
    res.json({ products: [] });
  }
});

// Buscar categorias SEM cache
app.get("/api/categories", async (req, res) => {
  try {
    console.log('🔄 Buscando categorias do banco...');
    
    const { data: categories, error } = await supabase
      .from('categories')
      .select('*')
      .order('name');

    if (error) {
      console.error("❌ Erro ao buscar categorias:", error.message);
      return res.json({ categories: [] });
    }

    let normalizedCategories = [];
    
    if (categories && categories.length > 0) {
      normalizedCategories = normalizeCategories(categories);
      console.log(`✅ ${normalizedCategories.length} categorias carregadas`);
    } else {
      normalizedCategories = [];
    }

    res.json({ categories: normalizedCategories });
  } catch (error) {
    console.error("❌ Erro ao buscar categorias:", error);
    res.json({ categories: [] });
  }
});

// Salvar produtos
app.post("/api/products", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !checkAuth(authHeader.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Não autorizado" });
    }
    
    const { products } = req.body;
    console.log(`💾 Salvando ${products?.length || 0} produtos...`);
    
    const normalizedProducts = normalizeProducts(products);

    // Deletar todos os produtos existentes
    const { error: deleteError } = await supabase
      .from('products')
      .delete()
      .neq('id', 0);

    if (deleteError && !deleteError.message.includes('No rows found')) {
      console.error('❌ Erro ao deletar produtos:', deleteError);
      throw deleteError;
    }

    // Inserir novos produtos
    if (normalizedProducts.length > 0) {
      const productsToInsert = normalizedProducts.map(product => ({
        title: product.title,
        category: product.category,
        price: product.price,
        description: product.description,
        status: product.status,
        colors: product.colors
      }));

      const { error: insertError } = await supabase
        .from('products')
        .insert(productsToInsert);

      if (insertError) {
        console.error('❌ Erro ao inserir produtos:', insertError);
        throw insertError;
      }
    }

    // Limpar cache
    clearCache();

    console.log('✅ Produtos salvos com sucesso!');
    res.json({ success: true, message: `${normalizedProducts.length} produtos salvos` });
  } catch (error) {
    console.error("❌ Erro ao salvar produtos:", error);
    res.status(500).json({ error: "Erro ao salvar produtos: " + error.message });
  }
});

// Adicionar categoria individual
app.post("/api/categories/add", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !checkAuth(authHeader.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Não autorizado" });
    }
    
    const { category } = req.body;
    
    if (!category || !category.id || !category.name) {
      return res.status(400).json({ error: "Dados da categoria inválidos" });
    }

    console.log(`➕ Adicionando categoria: ${category.name}`);

    const { data, error } = await supabase
      .from('categories')
      .upsert([{
        id: category.id,
        name: category.name,
        description: category.description || `Categoria de ${category.name}`
      }], {
        onConflict: 'id'
      });

    if (error) {
      console.error('❌ Erro ao adicionar categoria:', error);
      throw error;
    }

    console.log('✅ Categoria adicionada com sucesso!');
    res.json({ success: true, message: `Categoria "${category.name}" adicionada` });
  } catch (error) {
    console.error("❌ Erro ao adicionar categoria:", error);
    res.status(500).json({ error: "Erro ao adicionar categoria: " + error.message });
  }
});

// Excluir categoria individual
app.delete("/api/categories/:categoryId", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !checkAuth(authHeader.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Não autorizado" });
    }
    
    const { categoryId } = req.params;
    console.log(`🗑️ Excluindo categoria: ${categoryId}`);
    
    // Verificar se a categoria existe
    const { data: category, error: fetchError } = await supabase
      .from('categories')
      .select('*')
      .eq('id', categoryId)
      .single();

    if (fetchError || !category) {
      return res.status(404).json({ error: "Categoria não encontrada" });
    }

    // Verificar se há produtos usando esta categoria
    const { data: productsInCategory } = await supabase
      .from('products')
      .select('id, title')
      .eq('category', categoryId);

    // Se há produtos, mover para outra categoria
    if (productsInCategory && productsInCategory.length > 0) {
      console.log(`🔄 Movendo ${productsInCategory.length} produtos...`);
      
      // Buscar outra categoria
      const { data: otherCategories } = await supabase
        .from('categories')
        .select('id')
        .neq('id', categoryId)
        .limit(1);

      if (otherCategories && otherCategories.length > 0) {
        const newCategoryId = otherCategories[0].id;
        await supabase
          .from('products')
          .update({ category: newCategoryId })
          .eq('category', categoryId);
      }
    }

    // Deletar a categoria
    const { error: deleteError } = await supabase
      .from('categories')
      .delete()
      .eq('id', categoryId);

    if (deleteError) {
      throw deleteError;
    }

    console.log('✅ Categoria excluída com sucesso!');
    res.json({ success: true, message: `Categoria "${category.name}" excluída` });
  } catch (error) {
    console.error("❌ Erro ao excluir categoria:", error);
    res.status(500).json({ error: "Erro ao excluir categoria: " + error.message });
  }
});

// Verificar autenticação
app.get("/api/auth/verify", async (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    
    if (token && checkAuth(token)) {
      res.json({ valid: true, user: { username: "admin" } });
    } else {
      res.json({ valid: false });
    }
  } catch (error) {
    console.error("❌ Erro ao verificar autenticação:", error);
    res.status(500).json({ error: "Erro ao verificar autenticação" });
  }
});

// Inicializar servidor
const PORT = process.env.PORT || 3000;

// Função de inicialização
async function initializeServer() {
  await migrateDataToSupabase();
  
  app.listen(PORT, () => {
    console.log(`🚀 Servidor UrbanZ rodando na porta ${PORT}`);
    console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 URL do Supabase: ${supabaseUrl ? '✅ Configurado' : '❌ Não configurado'}`);
  });
}

// Iniciar servidor
initializeServer();

// Exportar para Vercel
export default app;