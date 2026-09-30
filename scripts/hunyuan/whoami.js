import 'dotenv/config'
import { sts } from 'tencentcloud-sdk-nodejs-sts'

/**
 * 密钥身份诊断：查询 .env 中腾讯云密钥属于哪个账号（UIN）
 * 用于定位「控制台看得到资源包积分，但 API 报积分已用尽」这类账号错配问题
 * 用法:
 *   node scripts/hunyuan/whoami.js
 */

const secretId = process.env.TENCENTCLOUD_SECRET_ID
const secretKey = process.env.TENCENTCLOUD_SECRET_KEY

if(!secretId || !secretKey)
{
    console.error('✘ .env 中缺少 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY')
    process.exit(1)
}

const client = new sts.v20180813.Client({
    credential: { secretId, secretKey },
    region: process.env.TENCENTCLOUD_REGION || 'ap-guangzhou'
})

try
{
    const result = await client.GetCallerIdentity({})
    console.log('✔ 密钥有效，身份如下：')
    console.log(`  账号 UIN : ${result.AccountId}`)
    console.log(`  身份 ARN : ${result.Arn}`)
    console.log(`  SecretId : ${secretId.slice(0, 8)}…（共 ${secretId.length} 字符）`)
    console.log('\n请对照腾讯云控制台右上角「账号信息」中的账号 ID（UIN），确认与本密钥一致。')
    console.log('再打开 https://console.cloud.tencent.com/ai3d → 资源包管理，确认积分领在本账号下。')
}
catch(error)
{
    console.error(`✘ 调用失败: ${error.code || error.name} ${error.message}`)
    process.exit(1)
}
