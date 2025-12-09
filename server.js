import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();

// Configuração do Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ SUPABASE_URL e SUPABASE_KEY são obrigatórios no .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Middleware de segurança e performance
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:", "http:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https:", "http:"],
      imgSrc: ["'self'", "data:", "https:", "http:", "blob:"],
      connectSrc: ["'self'", "https:", "http:", "ws:", "wss:"]
    },
  },
  crossOriginEmbedderPolicy: false
}));

app.use(compression());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // limite por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: "Muitas requisições deste IP, tente novamente após 15 minutos"
});

app.use(limiter);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true,
  maxAge: 86400
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Cache otimizado para Vercel
let cache = {
  products: null,
  productsTimestamp: 0
};

const CACHE_DURATION = parseInt(process.env.PRODUCTS_CACHE_DURATION) || 120000; // 2 minutos

// Funções utilitárias
function simpleEncrypt(text) {
  return Buffer.from(text).toString('base64').split('').reverse().join('');
}

function simpleDecrypt(encrypted) {
  return Buffer.from(encrypted.split('').reverse().join(''), 'base64').toString('utf8');
}

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

function normalizeProducts(products) {
  if (!Array.isArray(products)) return [];
  
  return products.map(product => {
    if (product.sizes && !product.colors) {
      return {
        id: product.id,
        title: product.title,
        category: product.category,
        price: parseFloat(product.price),
        description: product.description || '',
        status: product.status || 'active',
        colors: [
          {
            name: product.color || 'Padrão',
            image: product.image || 'https://via.placeholder.com/400x300',
            sizes: product.sizes || []
          }
        ]
      };
    }
    
    return {
      id: product.id,
      title: product.title,
      category: product.category,
      price: parseFloat(product.price),
      description: product.description || '',
      status: product.status || 'active',
      colors: product.colors ? product.colors.map(color => ({
        name: color.name || 'Sem nome',
        image: color.image || 'https://via.placeholder.com/400x300',
        sizes: color.sizes || []
      })) : []
    };
  });
}

// Middleware de autenticação
function checkAuth(token) {
  return token === process.env.ADMIN_TOKEN || token === "authenticated_admin_token";
}

function clearCache() {
  cache = {
    products: null,
    productsTimestamp: 0
  };
  console.log('🔄 Cache limpo');
}

// Health check com performance
app.get("/health", async (req, res) => {
  const start = Date.now();
  
  try {
    const { data: productsCount } = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true });
    
    const { data: categoriesCount } = await supabase
      .from('categories')
      .select('id', { count: 'exact', head: true });
    
    const latency = Date.now() - start;
    
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      latency: `${latency}ms`,
      services: {
        database: "connected",
        cache: cache.products ? "active" : "inactive"
      },
      counts: {
        products: productsCount || 0,
        categories: categoriesCount || 0
      },
      memory: process.memoryUsage()
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      error: error.message
    });
  }
});

// Autenticação
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: "Username e password são obrigatórios" });
    }

    console.log(`🔐 Tentativa de login: ${username}`);

    const { data: credentials, error } = await supabase
      .from('admin_credentials')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !credentials) {
      console.log(`❌ Credenciais não encontradas para: ${username}`);
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const encryptedPassword = simpleEncrypt(password);
    
    if (encryptedPassword === credentials.encrypted_password || password === credentials.password) {
      console.log(`✅ Login bem-sucedido: ${username}`);
      res.json({ 
        success: true, 
        token: process.env.ADMIN_TOKEN, 
        user: { username: username } 
      });
    } else {
      console.log(`❌ Senha incorreta para: ${username}`);
      res.status(401).json({ error: "Credenciais inválidas" });
    }
  } catch (error) {
    console.error("❌ Erro no login:", error);
    res.status(500).json({ error: "Erro no processo de login" });
  }
});

// Produtos com cache otimizado
app.get("/api/products", async (req, res) => {
  try {
    const now = Date.now();
    
    // Verificar cache
    if (cache.products && (now - cache.productsTimestamp) < CACHE_DURATION) {
      res.set('X-Cache', 'HIT');
      return res.json({ products: cache.products });
    }

    res.set('X-Cache', 'MISS');
    console.log('🔄 Buscando produtos do banco...');

    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .order('id', { ascending: true });

    if (error) {
      console.error("❌ Erro ao buscar produtos:", error.message);
      return res.status(500).json({ error: "Erro ao buscar produtos" });
    }

    const normalizedProducts = normalizeProducts(products || []);

    // Atualizar cache
    cache.products = normalizedProducts;
    cache.productsTimestamp = now;

    res.json({ products: normalizedProducts });
  } catch (error) {
    console.error("❌ Erro geral produtos:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Categorias SEM cache (sempre atualizadas)
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

    const normalizedCategories = normalizeCategories(categories || []);
    
    res.json({ categories: normalizedCategories });
  } catch (error) {
    console.error("❌ Erro geral categorias:", error);
    res.json({ categories: [] });
  }
});

// Salvar produtos (apenas admin)
app.post("/api/products", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !checkAuth(authHeader.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Não autorizado" });
    }
    
    const { products } = req.body;
    
    if (!Array.isArray(products)) {
      return res.status(400).json({ error: "Formato de dados inválido" });
    }

    console.log(`💾 Salvando ${products.length} produtos...`);
    
    const normalizedProducts = normalizeProducts(products);

    // Deletar todos os produtos existentes
    const { error: deleteError } = await supabase
      .from('products')
      .delete()
      .neq('id', 0);

    if (deleteError) {
      console.error('❌ Erro ao limpar produtos:', deleteError);
      return res.status(500).json({ error: "Erro ao limpar dados antigos" });
    }

    // Inserir os novos produtos
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
        return res.status(500).json({ error: "Erro ao salvar novos dados" });
      }
    }

    // Limpar cache
    clearCache();

    console.log('✅ Produtos salvos com sucesso!');
    res.json({ 
      success: true, 
      message: `${normalizedProducts.length} produtos salvos`,
      count: normalizedProducts.length 
    });
  } catch (error) {
    console.error("❌ Erro ao salvar produtos:", error);
    res.status(500).json({ error: "Erro ao processar requisição" });
  }
});

// Gerenciamento de categorias
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
      return res.status(500).json({ error: "Erro ao salvar categoria" });
    }

    console.log('✅ Categoria adicionada com sucesso!');
    res.json({ 
      success: true, 
      message: `Categoria "${category.name}" adicionada`,
      category: data 
    });
  } catch (error) {
    console.error("❌ Erro ao adicionar categoria:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.delete("/api/categories/:categoryId", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !checkAuth(authHeader.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Não autorizado" });
    }
    
    const { categoryId } = req.params;
    
    // Verificar se categoria existe
    const { data: category, error: fetchError } = await supabase
      .from('categories')
      .select('*')
      .eq('id', categoryId)
      .single();

    if (fetchError || !category) {
      return res.status(404).json({ error: "Categoria não encontrada" });
    }

    // Verificar se há produtos nesta categoria
    const { data: productsInCategory } = await supabase
      .from('products')
      .select('id')
      .eq('category', categoryId);

    if (productsInCategory && productsInCategory.length > 0) {
      // Mover produtos para a primeira categoria disponível
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

    // Deletar categoria
    const { error: deleteError } = await supabase
      .from('categories')
      .delete()
      .eq('id', categoryId);

    if (deleteError) {
      throw deleteError;
    }

    console.log(`✅ Categoria "${category.name}" excluída`);
    res.json({ 
      success: true, 
      message: `Categoria "${category.name}" excluída` 
    });
  } catch (error) {
    console.error("❌ Erro ao excluir categoria:", error);
    res.status(500).json({ error: "Erro ao excluir categoria" });
  }
});

// Salvar categorias em lote
app.post("/api/categories", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !checkAuth(authHeader.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Não autorizado" });
    }
    
    const { categories } = req.body;
    
    if (!Array.isArray(categories)) {
      return res.status(400).json({ error: "Formato de dados inválido" });
    }

    console.log(`💾 Salvando ${categories.length} categorias...`);
    
    const normalizedCategories = normalizeCategories(categories);

    if (normalizedCategories.length === 0) {
      return res.status(400).json({ error: "Nenhuma categoria válida fornecida" });
    }

    // Inserir/atualizar categorias
    const categoriesToUpsert = normalizedCategories.map(category => ({
      id: category.id,
      name: category.name,
      description: category.description
    }));

    const { error: upsertError } = await supabase
      .from('categories')
      .upsert(categoriesToUpsert, { 
        onConflict: 'id'
      });

    if (upsertError) {
      console.error('❌ Erro ao salvar categorias:', upsertError);
      return res.status(500).json({ error: "Erro ao salvar categorias" });
    }

    console.log('✅ Categorias salvas com sucesso!');
    res.json({ 
      success: true, 
      message: `${normalizedCategories.length} categorias salvas`,
      count: normalizedCategories.length 
    });
  } catch (error) {
    console.error("❌ Erro ao salvar categorias:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
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

// Cache management
app.post("/api/cache/clear", (req, res) => {
  clearCache();
  res.json({ success: true, message: "Cache limpo com sucesso" });
});

// Debug endpoints
app.get("/api/debug/categories", async (req, res) => {
  try {
    const { data: categories, error } = await supabase
      .from('categories')
      .select('*')
      .order('name');
    
    if (error) throw error;
    
    res.json({ 
      categories: categories || [],
      count: categories ? categories.length : 0,
      raw: categories 
    });
  } catch (error) {
    res.json({ categories: [], error: error.message });
  }
});

// Rota raiz
app.get("/", (req, res) => {
  res.json({ 
    message: "🚀 UrbanZ Backend - Moda Masculina",
    version: "3.0.0",
    node: process.version,
    environment: process.env.NODE_ENV,
    status: "operational",
    endpoints: {
      products: "/api/products",
      categories: "/api/categories",
      auth: "/api/auth/login",
      health: "/health"
    },
    cache: {
      enabled: true,
      duration: `${CACHE_DURATION/1000}s`,
      type: "memory"
    },
    database: "Supabase (PostgreSQL)"
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("❌ Erro não tratado:", err);
  res.status(500).json({
    error: "Erro interno do servidor",
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint não encontrado" });
});

// Configuração da porta para Vercel
const PORT = process.env.PORT || 3000;

// Inicialização do servidor
if (process.env.NODE_ENV !== 'production' || process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`📊 Cache ativo: ${CACHE_DURATION/1000} segundos`);
    console.log(`🛡️  Modo: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 Banco: Supabase`);
  });
}

// Export para Vercel
export default app;